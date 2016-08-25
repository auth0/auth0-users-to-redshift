module.exports =
/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};

/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {

/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;

/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};

/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);

/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;

/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}


/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;

/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;

/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "/build/";

/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	// const Loggly    = require('loggly');
	// var Redshift    = require('node-redshift');
	var bricks = __webpack_require__(1);
	var insert = bricks.insert;
	var Pg = __webpack_require__(3);
	var Auth0 = __webpack_require__(4);
	var async = __webpack_require__(5);
	var moment = __webpack_require__(6);
	var useragent = __webpack_require__(7);
	var express = __webpack_require__(8);
	var Webtask = __webpack_require__(9);
	var app = express();
	var Request = __webpack_require__(12);
	var memoizer = __webpack_require__(13);

	function lastLogCheckpoint(req, res) {
	  var ctx = req.webtaskContext;
	  var required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'];
	  var missing_settings = required_settings.filter(function (setting) {
	    return !ctx.data[setting];
	  });

	  if (missing_settings.length) {
	    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
	  }

	  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
	  req.webtaskContext.storage.get(function (err, data) {

	    var startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

	    // Initialize both clients.
	    var auth0 = new Auth0.ManagementClient({
	      domain: ctx.data.AUTH0_DOMAIN,
	      token: req.access_token
	    });

	    var credentials = {
	      user: ctx.data.AWS_REDSHIFT_USER,
	      database: ctx.data.AWS_REDSHIFT_DATABASE,
	      password: ctx.data.AWS_REDSHIFT_PASSWORD,
	      port: ctx.data.AWS_REDSHIFT_PORT,
	      host: ctx.data.AWS_REDSHIFT_HOST
	    };

	    //this initializes a connection pool
	    //it will keep idle connections open for a 30 seconds
	    //and set a limit of maximum 10 idle clients
	    var pool = new pg.Pool(credentials);

	    // Start the process.
	    async.waterfall([function (callback) {
	      var getLogs = function getLogs(context) {
	        console.log('Logs from: ' + (context.checkpointId || 'Start') + '.');

	        var take = Number.parseInt(ctx.data.BATCH_SIZE);

	        take = take > 100 ? 100 : take;

	        context.logs = context.logs || [];

	        getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, take, context.checkpointId, function (logs, err) {
	          if (err) {
	            console.log('Error getting logs from Auth0', err);
	            return callback(err);
	          }

	          if (logs && logs.length) {
	            logs.forEach(function (l) {
	              return context.logs.push(l);
	            });
	            context.checkpointId = context.logs[context.logs.length - 1]._id;
	          }

	          console.log('Total logs: ' + context.logs.length + '.');
	          return callback(null, context);
	        });
	      };

	      getLogs({ checkpointId: startCheckpointId });
	    }, function (context, callback) {
	      var min_log_level = parseInt(ctx.data.LOG_LEVEL) || 0;
	      var log_matches_level = function log_matches_level(log) {
	        if (logTypes[log.type]) {
	          return logTypes[log.type].level >= min_log_level;
	        }
	        return true;
	      };

	      var types_filter = ctx.data.LOG_TYPES && ctx.data.LOG_TYPES.split(',') || [];
	      var log_matches_types = function log_matches_types(log) {
	        if (!types_filter || !types_filter.length) return true;
	        return log.type && types_filter.indexOf(log.type) >= 0;
	      };

	      context.logs = context.logs.filter(function (l) {
	        return l.type !== 'sapi' && l.type !== 'fapi';
	      }).filter(log_matches_level).filter(log_matches_types);

	      callback(null, context);
	    }, function (context, callback) {
	      console.log('Sending ' + context.logs.length);

	      pool.connect(function (err, client, done) {
	        if (err) {
	          return callback(err);
	        }

	        async.eachLimit(context.logs, 5, function (log, cb) {
	          var query = insert('auth0logstest', {
	            date: log.date,
	            type: log.type,
	            connection: log.connection,
	            client_id: log.client_id,
	            client_name: log.client_name,
	            user_id: log.user_id,
	            user_name: log.user_name
	          });

	          client.query(query, function (err, result) {
	            if (err) {
	              return cb(err);
	            }
	            cb(null);
	          });
	        }, function (err) {
	          if (err) {
	            return callback(err);
	          }

	          done();

	          console.log('Upload complete.');
	          return callback(null, context);
	        });
	      });
	    }], function (err, context) {
	      if (err) {
	        console.log('Job failed.');

	        return req.webtaskContext.storage.set({ checkpointId: startCheckpointId }, { force: 1 }, function (error) {
	          if (error) {
	            console.log('Error storing startCheckpoint', error);
	            return res.status(500).send({ error: error });
	          }

	          res.status(500).send({
	            error: err
	          });
	        });
	      }

	      console.log('Job complete.');

	      return req.webtaskContext.storage.set({
	        checkpointId: context.checkpointId,
	        totalLogsProcessed: context.logs.length
	      }, { force: 1 }, function (error) {
	        if (error) {
	          console.log('Error storing checkpoint', error);
	          return res.status(500).send({ error: error });
	        }

	        res.sendStatus(200);
	      });
	    });
	  });
	}

	var logTypes = {
	  's': {
	    event: 'Success Login',
	    level: 1 // Info
	  },
	  'seacft': {
	    event: 'Success Exchange',
	    level: 1 // Info
	  },
	  'feacft': {
	    event: 'Failed Exchange',
	    level: 3 // Error
	  },
	  'f': {
	    event: 'Failed Login',
	    level: 3 // Error
	  },
	  'w': {
	    event: 'Warnings During Login',
	    level: 2 // Warning
	  },
	  'du': {
	    event: 'Deleted User',
	    level: 1 // Info
	  },
	  'fu': {
	    event: 'Failed Login (invalid email/username)',
	    level: 3 // Error
	  },
	  'fp': {
	    event: 'Failed Login (wrong password)',
	    level: 3 // Error
	  },
	  'fc': {
	    event: 'Failed by Connector',
	    level: 3 // Error
	  },
	  'fco': {
	    event: 'Failed by CORS',
	    level: 3 // Error
	  },
	  'con': {
	    event: 'Connector Online',
	    level: 1 // Info
	  },
	  'coff': {
	    event: 'Connector Offline',
	    level: 3 // Error
	  },
	  'fcpro': {
	    event: 'Failed Connector Provisioning',
	    level: 4 // Critical
	  },
	  'ss': {
	    event: 'Success Signup',
	    level: 1 // Info
	  },
	  'fs': {
	    event: 'Failed Signup',
	    level: 3 // Error
	  },
	  'cs': {
	    event: 'Code Sent',
	    level: 0 // Debug
	  },
	  'cls': {
	    event: 'Code/Link Sent',
	    level: 0 // Debug
	  },
	  'sv': {
	    event: 'Success Verification Email',
	    level: 0 // Debug
	  },
	  'fv': {
	    event: 'Failed Verification Email',
	    level: 0 // Debug
	  },
	  'scp': {
	    event: 'Success Change Password',
	    level: 1 // Info
	  },
	  'fcp': {
	    event: 'Failed Change Password',
	    level: 3 // Error
	  },
	  'sce': {
	    event: 'Success Change Email',
	    level: 1 // Info
	  },
	  'fce': {
	    event: 'Failed Change Email',
	    level: 3 // Error
	  },
	  'scu': {
	    event: 'Success Change Username',
	    level: 1 // Info
	  },
	  'fcu': {
	    event: 'Failed Change Username',
	    level: 3 // Error
	  },
	  'scpn': {
	    event: 'Success Change Phone Number',
	    level: 1 // Info
	  },
	  'fcpn': {
	    event: 'Failed Change Phone Number',
	    level: 3 // Error
	  },
	  'svr': {
	    event: 'Success Verification Email Request',
	    level: 0 // Debug
	  },
	  'fvr': {
	    event: 'Failed Verification Email Request',
	    level: 3 // Error
	  },
	  'scpr': {
	    event: 'Success Change Password Request',
	    level: 0 // Debug
	  },
	  'fcpr': {
	    event: 'Failed Change Password Request',
	    level: 3 // Error
	  },
	  'fn': {
	    event: 'Failed Sending Notification',
	    level: 3 // Error
	  },
	  'sapi': {
	    event: 'API Operation'
	  },
	  'fapi': {
	    event: 'Failed API Operation'
	  },
	  'limit_wc': {
	    event: 'Blocked Account',
	    level: 4 // Critical
	  },
	  'limit_ui': {
	    event: 'Too Many Calls to /userinfo',
	    level: 4 // Critical
	  },
	  'api_limit': {
	    event: 'Rate Limit On API',
	    level: 4 // Critical
	  },
	  'sdu': {
	    event: 'Successful User Deletion',
	    level: 1 // Info
	  },
	  'fdu': {
	    event: 'Failed User Deletion',
	    level: 3 // Error
	  }
	};

	function getLogsFromAuth0(domain, token, take, from, cb) {
	  var url = 'https://' + domain + '/api/v2/logs';

	  Request.get(url).set('Authorization', 'Bearer ' + token).set('Accept', 'application/json').query({ take: take }).query({ from: from }).query({ sort: 'date:1' }).query({ per_page: take }).end(function (err, res) {
	    if (err || !res.ok) {
	      console.log('Error getting logs', err);
	      cb(null, err);
	    } else {
	      console.log('x-ratelimit-limit: ', res.headers['x-ratelimit-limit']);
	      console.log('x-ratelimit-remaining: ', res.headers['x-ratelimit-remaining']);
	      console.log('x-ratelimit-reset: ', res.headers['x-ratelimit-reset']);
	      cb(res.body);
	    }
	  });
	}

	var getTokenCached = memoizer({
	  load: function load(apiUrl, audience, clientId, clientSecret, cb) {
	    Request.post(apiUrl).send({
	      audience: audience,
	      grant_type: 'client_credentials',
	      client_id: clientId,
	      client_secret: clientSecret
	    }).type('application/json').end(function (err, res) {
	      if (err || !res.ok) {
	        cb(null, err);
	      } else {
	        cb(res.body.access_token);
	      }
	    });
	  },
	  hash: function hash(apiUrl) {
	    return apiUrl;
	  },
	  max: 100,
	  maxAge: 1000 * 60 * 60
	});

	app.use(function (req, res, next) {
	  var apiUrl = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/oauth/token';
	  var audience = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/api/v2/';
	  var clientId = req.webtaskContext.data.AUTH0_CLIENT_ID;
	  var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;

	  getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
	    if (err) {
	      console.log('Error getting access_token', err);
	      return next(err);
	    }

	    req.access_token = access_token;
	    next();
	  });
	});

	app.get('/', lastLogCheckpoint);
	app.post('/', lastLogCheckpoint);

	module.exports = Webtask.fromExpress(app);

/***/ },
/* 1 */
/***/ function(module, exports, __webpack_require__) {

	(function() {
	  "use strict";

	  var is_common_js = typeof exports != 'undefined';
	  var default_opts = { placeholder: '?' };
	  
	  var _;
	  if (is_common_js)
	    _ = __webpack_require__(2);
	  else
	    _ = window._;

	  // sql() wrapper allows SQL (column/table/etc) where a value (string/number/etc) is expected
	  // it is also the main namespace for SQLBricks
	  function sql(str) {
	    if (!(this instanceof sql))
	      return applyNew(sql, arguments);

	    this.str = str;
	    this.vals = _.toArray(arguments).slice(1);

	    // support passing a single array
	    if (_.isArray(this.vals[0]))
	      this.vals = this.vals[0];
	  }
	  sql.prototype.toString = function toString(opts) {
	    function replacer(match, capture) {
	      // don't do any replacing if the user supplied no values
	      if (!opts.values.length)
	        return match;

	      var ix = capture ? parseInt(capture, 10) : opts.value_ix++;
	      var val = opts.values[ix - 1];
	      if (_.isUndefined(val))
	        throw new Error('Parameterized sql() (' + str + ') requires ' + ix + ' parameter(s) but only ' + opts.values.length + ' parameter(s) were supplied');
	      if (_.isObject(sql) && !_.isArray(sql) && sql == null)
	        return val.toString(opts);
	      else
	        return sql.convert(val);
	    }

	    var str = this.str;
	    if (!opts)
	      opts = default_opts;
	    if (!opts.values)
	      opts.values = [];
	    if (!opts.value_ix)
	      opts.value_ix = 1;

	    this.vals.forEach(function(val) {
	      opts.values.push(val);
	    });

	    // shift the placeholder indexes if there are already values
	    if (opts.value_ix > 1) {
	      var orig_val_ix = opts.value_ix;
	      if (opts.placeholder == '$%d')
	        str = str.replace(/\$(\d+)/g, function(match, capture) { opts.value_ix++; return '$' + (parseInt(capture, 10) + orig_val_ix - 1); });
	      else if (opts.placeholder == '?%d')
	        str = str.replace(/\?(\d+)/g, function(match, capture) { opts.value_ix++; return '?' + parseInt(capture, 10) + orig_val_ix - 1; });
	    }

	    // inject numbers into placeholders if numbers are required
	    if (opts.placeholder == '$%d')
	      str = str.replace(/\$(?!\d)/g, function() { return '$' + opts.value_ix++; });
	    else if (opts.placeholder == '?%d')
	      str = str.replace(/\?(?!\d)/g, function() { return '?' + opts.value_ix++; });

	    if (!opts.parameterized) {
	      // replace placeholders with inline values
	      if (opts.placeholder == '$%d')
	        str = str.replace(/\$(\d+)/g, replacer);
	      else if (opts.placeholder == '?%d')
	        str = str.replace(/\?(\d+)/g, replacer);
	      else if (opts.placeholder == '$')
	        str = str.replace(/\$/g, replacer);
	      else if (opts.placeholder == '?')
	        str = str.replace(/\?/g, replacer);
	      else
	        throw new Error('Unsupported placeholder: "' + opts.placeholder + '"');
	    }

	    return str;
	  };

	  // val() wrapper allows a value (string/number/etc) where SQL (column/table/etc) is expected
	  sql.val = val;
	  function val(_val) {
	    if (!(this instanceof val))
	      return new val(_val);
	    this.val = _val;
	  }

	  // mechanism to easily define clauses for SQL statements
	  [Select, Insert, Update, Delete].forEach(function(stmt) {
	    stmt.defineClause = function(clause_id, template, opts) {
	      opts = opts || {};
	      var clauses = this.prototype.clauses = this.prototype.clauses || [];

	      var templ_fn = template;
	      if (typeof templ_fn != 'function')
	        templ_fn = function(opts) { return templ(template, this, opts); };
	      this.prototype[clause_id + 'ToString'] = templ_fn;
	      
	      var index;
	      if (opts.after || opts.before) {
	        index = clauses.indexOf(opts.after || opts.before);
	        if (index == -1)
	          throw new Error('Error adding clause ' + clause_id + ': dependent clause "' + opts.after + '" not found');
	        
	        if (opts.after)
	          index++;
	      }
	      else {
	        index = clauses.length;
	      }
	      clauses.splice(index, 0, clause_id);
	    };
	  });

	  // SELECT statement
	  sql.select = inherits(Select, Statement);
	  function Select() {
	    if (!(this instanceof Select))
	      return new Select(argsToArray(arguments));

	    Select.super_.call(this, 'select');
	    return this.select.apply(this, arguments);
	  }

	  Select.prototype.select = function() {
	    return this._addListArgs(arguments, '_columns');
	  };
	  Select.prototype.distinct = function() {
	    this._distinct = true;
	    return this._addListArgs(arguments, '_columns');
	  };
	  Select.prototype.into = Select.prototype.intoTable = function(tbl) {
	    this._into = tbl;
	    return this;
	  };
	  Select.prototype.intoTemp = Select.prototype.intoTempTable = function(tbl) {
	    this._temp = true;
	    this._into = tbl;
	    return this;
	  };
	  Select.prototype.from = function() {
	    return this._addListArgs(arguments, '_from');
	  };

	  var join_methods = {
	    'join': 'INNER', 'innerJoin': 'INNER',
	    'leftJoin': 'LEFT', 'leftOuterJoin': 'LEFT',
	    'rightJoin': 'RIGHT', 'rightOuterJoin': 'RIGHT',
	    'fullJoin': 'FULL', 'fullOuterJoin': 'FULL',
	    'naturalJoin': 'NATURAL INNER', 'naturalInnerJoin': 'NATURAL INNER',
	    'naturalLeftJoin': 'NATURAL LEFT', 'naturalLeftOuterJoin': 'NATURAL LEFT',
	    'naturalRightJoin': 'NATURAL RIGHT', 'naturalRightOuterJoin': 'NATURAL RIGHT',
	    'naturalFullJoin': 'NATURAL FULL', 'naturalFullOuterJoin': 'NATURAL FULL',
	    'crossJoin': 'CROSS'
	  };
	  Object.keys(join_methods).forEach(function(method) {
	    Select.prototype[method] = function join() {
	      return this._addJoins(arguments, join_methods[method]);
	    };
	  });
	  Select.prototype.on = function(on) {
	    var last_join = this.joins[this.joins.length - 1];
	    if (_.isArray(last_join.on) && !_.isEmpty(last_join.on))
	      throw new Error('Error adding clause ON: ' + last_join.left_tbl + ' JOIN ' + last_join.tbl + ' already has a USING clause.');
	    if (isExpr(on)) {
	      last_join.on = on;
	    }
	    else {
	      if (!last_join.on || (_.isArray(last_join.on))) // Instantiate object, including if it's an empty array from .using().
	        last_join.on = {};
	      _.extend(last_join.on, argsToObject(arguments));
	    }
	    return this;
	  };
	  Select.prototype.using = function(columns) {
	    var last_join = this.joins[this.joins.length - 1];
	    if (!_.isEmpty(last_join.on) && !_.isArray(last_join.on))
	      throw new Error('Error adding clause USING: ' + last_join.left_tbl + ' JOIN ' + last_join.tbl + ' already has an ON clause.');

	    if (_.isEmpty(last_join.on))
	      last_join.on = []; // Using _.isEmpty tolerates overwriting of empty {}.
	    last_join.on = _.union(last_join.on, argsToArray(arguments));
	    return this;
	  };

	  Select.prototype.where = Select.prototype.and = function() {
	    return this._addExpression(arguments, '_where');
	  };
	  Select.prototype.having = function() {
	    return this._addExpression(arguments, '_having');
	  };
	  Select.prototype.groupBy = Select.prototype.group = function() {
	    return this._addListArgs(arguments, '_groupBy');
	  };
	  Select.prototype.orderBy = Select.prototype.order = function() {
	    return this._addListArgs(arguments, '_orderBy');
	  };
	  Select.prototype.of = function() {
	    return this._addListArgs(arguments, '_of');
	  };

	  Select.prototype.forUpdate = function() {
	    this._forUpdate = true;
	    return this;
	  };
	  Select.prototype.noWait = function() {
	    this._noWait = true;
	    return this;
	  };

	  // TODO: Don't we need to keep track of the order of UNION, INTERSECT, etc, clauses?
	  var compounds = {
	    'union': 'UNION', 'unionAll': 'UNION ALL',
	    'intersect': 'INTERSECT', 'intersectAll': 'INTERSECT ALL',
	    'except': 'EXCEPT', 'exceptAll': 'EXCEPT ALL'
	  };
	  _.forEach(compounds, function(value, key) {
	    Select.prototype[key] = function() {
	      var stmts = argsToArray(arguments);
	      if (!stmts.length) {
	        var stmt = new Select();
	        stmt.prev_stmt = this;
	        stmts = [stmt];
	      }

	      this._add(stmts, '_' + key);

	      if (stmt)
	        return stmt;
	      else
	        return this;
	    };
	  });

	  // subquery aliasing
	  Select.prototype._toNestedString = function(opts) {
	    return '(' + this._toString(opts) + ')' + this._aliasToString(opts);
	  };

	  Select.prototype._aliasToString = function(opts) {
	    if (!this._alias)
	      return '';

	    return ' ' + autoQuote(this._alias);
	  };

	  Select.prototype.as = function(alias) {
	    this._alias = alias;
	    return this;
	  };

	  Select.prototype._toString = function _toString(opts) {
	    if (!this._columns.length)
	      this._columns = ['*'];
	    return Select.super_.prototype._toString.apply(this, arguments);
	  };

	  Select.defineClause('select', 'SELECT {{#if _distinct}}DISTINCT {{/if}}{{#if _columns}}{{columns _columns}}{{/if}}');
	  Select.defineClause('into', '{{#if _into}}INTO {{#if _temp}}TEMP {{/if}}{{table _into}}{{/if}}');
	  Select.defineClause('from', function(opts) {
	    if (!this._from)
	      return;
	    var result = 'FROM ' + handleTables(this._from, opts);
	    if (this.joins)
	      result += ' ' + _.invoke(this.joins, 'toString', opts).join(' ');
	    return result;
	  });
	  Select.defineClause('where', '{{#if _where}}WHERE {{expression _where}}{{/if}}');
	  Select.defineClause('groupBy', '{{#if _groupBy}}GROUP BY {{columns _groupBy}}{{/if}}');
	  Select.defineClause('having', '{{#if _having}}HAVING {{expression _having}}{{/if}}');

	  _.forEach(compounds, function(sql_keyword, clause_id) {
	    Select.defineClause(clause_id, function(opts) {
	      var arr = this['_' + clause_id];
	      if (arr) {
	        return arr.map(function(stmt) {
	          return sql_keyword + ' ' + stmt._toString(opts);
	        }).join(' ');
	      }
	    });
	  });

	  Select.defineClause('orderBy', '{{#if _orderBy}}ORDER BY {{columns _orderBy}}{{/if}}');
	  Select.defineClause('forUpdate', '{{#if _forUpdate}}FOR UPDATE{{#if _of}} OF {{columns _of}}{{/if}}{{#if _noWait}} NO WAIT{{/if}}{{/if}}');


	  // INSERT statement
	  sql.insert = sql.insertInto = inherits(Insert, Statement);
	  function Insert(tbl, values) {
	    if (!(this instanceof Insert)) {
	      if (typeof values == 'object' && !_.isArray(values))
	        return new Insert(tbl, values);
	      else
	        return new Insert(tbl, argsToArray(_.toArray(arguments).slice(1)));
	    }

	    Insert.super_.call(this, 'insert');
	    return this.into.apply(this, arguments);
	  };

	  Insert.prototype.into = function into(tbl, values) {
	    if (tbl)
	      this._table = tbl;

	    if (values) {
	      if (isPlainObject(values) || (_.isArray(values) && isPlainObject(values[0]))) {
	        this.values(values);
	      }
	      else if (values.length) {
	        this._split_keys_vals_mode = true;
	        this._values = [{}];
	        var val_arr = argsToArray(_.toArray(arguments).slice(1));
	        _.forEach(val_arr, function(key) {
	          this._values[0][key] = null;
	        }.bind(this));
	      }
	    }
	    return this;
	  };
	  Insert.prototype.values = function values() {
	    if (this._split_keys_vals_mode) {
	      var outer_arr;
	      if (_.isArray(arguments[0]) && _.isArray(arguments[0][0]))
	        outer_arr = arguments[0];
	      else
	        outer_arr = [argsToArray(arguments)];

	      var keys = _.keys(this._values[0]);
	      _.forEach(outer_arr, function(args, outer_ix) {
	        if (!this._values[outer_ix])
	          this._values[outer_ix] = {};

	        _.forEach(keys, function(key, ix) {
	          this._values[outer_ix][key] = args[ix];
	        }.bind(this));
	      }.bind(this));
	    }
	    else {
	      if (_.isArray(arguments[0]) && isPlainObject(arguments[0][0])) {
	        if (!this._values)
	          this._values = [];
	        this._values = this._values.concat(arguments[0]);
	      }
	      else {
	        if (!this._values)
	          this._values = [{}];
	        _.extend(this._values[0], argsToObject(arguments));
	      }
	    }
	    return this;
	  };
	  Insert.prototype.select = function select() {
	    this._select = sql.select.apply(null, arguments);
	    this._select.prev_stmt = this;
	    return this._select;
	  };

	  Insert.defineClause('insert', 'INSERT');
	  Insert.defineClause('into', '{{#if _table}}INTO {{table _table}}{{/if}}');
	  Insert.defineClause('columns', function(opts) {
	    if (!this._values) return '';
	    return '(' + handleColumns(_.keys(this._values[0]), opts) + ')';
	  });
	  Insert.defineClause('values', function(opts) {
	    if (this._select)
	      return this._select._toString(opts);
	    else
	      return 'VALUES ' + _.map(this._values, function(values) {
	        return '(' + handleValues(_.values(values), opts).join(', ') + ')';
	      }).join(', ');
	  });


	  // UPDATE statement
	  sql.update = inherits(Update, Statement);
	  function Update(tbl, values) {
	    if (!(this instanceof Update))
	      return new Update(tbl, argsToObject(_.toArray(arguments).slice(1)));

	    Update.super_.call(this, 'update');
	    this._table = tbl;
	    if (values)
	      this.values(values);
	    return this;
	  };

	  Update.prototype.set = Update.prototype.values = function set() {
	    return this._addToObj(argsToObject(arguments), '_values');
	  };

	  Update.prototype.where = Update.prototype.and = Select.prototype.where;

	  Update.defineClause('update', 'UPDATE');
	  Update.defineClause('table', '{{table _table}}');
	  Update.defineClause('set', function(opts) {
	    return 'SET ' + _.map(this._values, function(value, key) {
	      return handleColumn(key, opts) + ' = ' + handleValue(value, opts);
	    }).join(', ');
	  });
	  Update.defineClause('where', '{{#if _where}}WHERE {{expression _where}}{{/if}}');


	  // DELETE statement
	  sql.delete = sql.deleteFrom = inherits(Delete, Statement);
	  function Delete(tbl) {
	    if (!(this instanceof Delete))
	      return new Delete(tbl);

	    Delete.super_.call(this, 'delete');
	    if (tbl)
	      this._from = tbl;
	    return this;
	  }
	  Delete.prototype.from = function(tbl) {
	    this._from = tbl;
	    return this;
	  };
	  Delete.prototype.where = Delete.prototype.and = Select.prototype.where;

	  Delete.defineClause('delete', 'DELETE FROM {{table _from}}');
	  Delete.defineClause('where', '{{#if _where}}WHERE {{expression _where}}{{/if}}');


	  // base statement
	  sql.Statement = Statement;
	  function Statement(type) {
	    this.type = type;
	  };

	  // TODO: this seems to not handle... a *lot* of properties
	  Statement.prototype.clone = function clone() {
	    var ctor = _.find([Select, Insert, Update, Delete], function(ctor) {
	      return this instanceof ctor;
	    }.bind(this));

	    var stmt = _.extend(new ctor(), this);
	    if (stmt._where)
	      stmt._where = stmt._where.clone();
	    if (stmt.joins)
	      stmt.joins = stmt.joins.slice();
	    if (stmt._values) {
	      if (_.isArray(stmt._values)) {
	        stmt._values = _.map(stmt._values, function(val) {
	          return _.clone(val);
	        });
	      }
	      else {
	        stmt._values = _.clone(stmt._values);
	      }
	    }
	    return stmt;
	  };

	  Statement.prototype.toParams = function toParams(opts) {
	    if (this.prev_stmt)
	      return this.prev_stmt.toParams(opts);

	    if (!opts)
	      opts = {};
	    _.extend(opts, {'parameterized': true, 'values': [], 'value_ix': 1});
	    _.defaults(opts, {'placeholder': '$%d'});
	    var sql = this._toString(opts);

	    return {'text': sql, 'values': opts.values};
	  };

	  Statement.prototype.toString = function toString(opts) {
	    if (!opts)
	      opts = {};
	    _.defaults(opts, {'placeholder': '$%d'});

	    if (this.prev_stmt)
	      return this.prev_stmt.toString(opts);
	    else
	      return this._toString(opts).trim();
	  };

	  Statement.prototype._toString = function(opts) {
	    var result = '';
	    this.clauses.forEach(function(clause) {
	      var rlt = this[clause + 'ToString'](opts);
	      if (rlt)
	        result += rlt + ' ';
	    }.bind(this));
	    return result.trim();
	  };

	  Statement.prototype._add = function _add(arr, name) {
	    if (!this[name])
	      this[name] = [];

	    this[name] = this[name].concat(arr);
	    return this;
	  };

	  Statement.prototype._addToObj = function _addToObj(obj, name) {
	    if (!this[name])
	      this[name] = {};

	    _.extend(this[name], obj);
	    return this;
	  };

	  Statement.prototype._addListArgs = function _addListArgs(args, name) {
	    return this._add(argsToArray(args), name);
	  };

	  Statement.prototype._addExpression = function _addExpression(args, name) {
	    if (args.length <= 1 && (args[0] == null || _.isEmpty(args[0])))
	      return this;

	    if (!this[name])
	      this[name] = sql.and();
	    var exprs = argsToExpressions(args);
	    this[name].expressions = this[name].expressions.concat(exprs);
	    return this;
	  };

	  Statement.prototype._addJoins = function _addJoins(args, type) {
	    if (!this.joins)
	      this.joins = [];

	    if (typeof args[1] == 'object') {
	      var tbls = [args[0]];
	      var on = args[1];
	      var opts = args[2];
	    }
	    else {
	      tbls = argsToArray(args);
	    }

	    _.forEach(tbls, function(tbl) {
	      var left_tbl = this.last_join || (this._from && this._from[this._from.length - 1]);
	      this.joins.push(new Join(tbl, left_tbl, on, type));
	    }.bind(this));

	    this.last_join = tbls[tbls.length - 1];
	    return this;
	  };


	  function Join(tbl, left_tbl, on, type) {
	    this.tbl = tbl;
	    this.left_tbl = left_tbl;
	    this.on = on;
	    this.type = type;
	  }
	  sql.Join = Join;
	  Join.prototype.autoGenerateOn = function autoGenerateOn(tbl, left_tbl) {
	    return sql._joinCriteria(getTable(left_tbl), getAlias(left_tbl), getTable(tbl), getAlias(tbl));
	  };
	  Join.prototype.toString = function toString(opts) {
	    var on = this.on, tbl = handleTable(this.tbl, opts);

	    // Natural or cross join, no criteria needed.
	    // Debt: Determining whether join is natural/cross by reading the string is slightly hacky... but works.
	    if (/^(natural|cross)/i.test(this.type))
	      return this.type + ' JOIN ' + tbl;
	    
	    // Not a natural or cross, check for criteria.
	    if (!on || _.isEmpty(on)) {
	      if (sql._joinCriteria) {
	        var left_tbl = handleTable(this.left_tbl, opts);
	        on = this.autoGenerateOn(tbl, left_tbl);
	      }
	      else {
	        throw new Error('No join criteria supplied for "' + getAlias(tbl) + '" join');
	      }
	    }

	    // Array value for on indicates join using "using", rather than "on".
	    if (_.isArray(on)) {
	      on = _.map(on, function (column) {
	        return handleColumn(column);
	      }).join(', ');
	      return this.type + ' JOIN ' + tbl + ' USING (' + on + ')';
	    }

	    // Join using "on".
	    if (isExpr(on)) {
	      on = on.toString(opts);
	    }
	    else {
	      on = _.map(_.keys(on), function(key) {
	        return handleColumn(key, opts) + ' = ' + handleColumn(on[key], opts);
	      }).join(' AND ')
	    }
	    return this.type + ' JOIN ' + tbl + ' ON ' + on;
	  };

	  // handle an array, a comma-delimited str or separate args
	  function argsToArray(args) {
	    if (_.isArray(args[0]))
	      return args[0];
	    else if (typeof args[0] == 'string' && args[0].indexOf(',') > -1)
	      return _.invoke(args[0].split(','), 'trim');
	    else
	      return _.toArray(args);
	  }

	  function argsToObject(args) {
	    if (typeof args[0] == 'object')
	      return args[0];

	    var obj = {};
	    if (args[0] != null)
	      obj[args[0]] = args[1];
	    return obj;
	  }

	  function argsToExpressions(args) {
	    var flat_args = _.all(args, function(arg) {
	      return typeof arg != 'object' || arg instanceof val || arg instanceof sql || arg == null;
	    });
	    if (flat_args) {
	      if (args[0] instanceof sql && args.length == 1)
	        return [args[0]];
	      else
	        return [sql.equal(args[0], args[1])];
	    }
	    else {
	      var exprs = [];
	      _.each(args, function(expr) {
	        if (isExpr(expr))
	          exprs.push(expr);
	        else
	          exprs = exprs.concat(objToEquals(expr));
	      });
	      return exprs;
	    }
	  }


	  // SQL Expression language
	  sql.and = function and() { return new Group('AND', argsToArray(arguments)); };
	  sql.or = function or() { return new Group('OR', argsToArray(arguments)); };

	  function Group(op, expressions) {
	    this.op = op;
	    this.expressions = [];
	    _.forEach(expressions, function(expr) {
	      if (isExpr(expr))
	        this.expressions.push(expr);
	      else
	        this.expressions = this.expressions.concat(objToEquals(expr));
	    }.bind(this));
	  }
	  sql.Group = Group;
	  Group.prototype.clone = function clone() {
	    return new Group(this.op, _.invoke(this.expressions, 'clone'));
	  };
	  Group.prototype.toString = function toString(opts) {
	    opts = opts||default_opts;
	    var sql = _.map(this.expressions, function(expr) {
	      return expr.toString(opts);
	    }).join(' ' + this.op + ' ');
	    if (this.expressions.length > 1 && this.parens !== false)
	      sql = '(' + sql + ')';
	    return sql;
	  };

	  sql.not = function not(expr) {
	    return new Not(expr);
	  };
	  function Not(expr) {
	    if (!isExpr(expr))
	      this.expressions = [sql.and(expr)];
	    else
	      this.expressions = [expr];
	  }
	  sql.Not = Not;
	  Not.prototype.clone = function clone() {
	    return new Not(this.expressions[0].clone());
	  };
	  Not.prototype.toString = function toString(opts) {
	    return 'NOT ' + this.expressions[0].toString(opts);
	  };

	  var binary_ops = {
	    'eq': '=', 'equal': '=', 'notEq': '<>',
	    'lt': '<', 'lte': '<=', 'gt': '>', 'gte': '>='
	  };
	  var quantifiers = ['All', 'Any'];

	  for (var name in binary_ops) {
	    sql[name] = function(name, col, val) {
	      return new Binary(binary_ops[name], col, val);
	    }.bind(null, name);

	    _.forEach(quantifiers, function(name, quantifier) {
	      sql[name + quantifier] = function(col, val) {
	        return new Binary(binary_ops[name], col, val, quantifier.toUpperCase() + ' ');
	      };
	    }.bind(null, name));
	    sql[name + 'Some'] = sql[name + 'Any'];
	  }

	  function Binary(op, col, val, quantifier) {
	    if (val == null) {
	      if (op == '=')
	        return sql.isNull(col);
	      else if (op == '<>')
	        return sql.isNotNull(col);
	    }

	    this.op = op;
	    this.col = col;
	    this.val = val;
	    this.quantifier = quantifier || '';
	  }
	  sql.Binary = Binary;
	  Binary.prototype.clone = function clone() {
	    return new Binary(this.op, this.col, this.val);
	  };
	  Binary.prototype.toString = function toString(opts) {
	    var sql = handleColumn(this.col, opts);
	    return sql + ' ' + this.op + ' ' + this.quantifier + handleValue(this.val, opts);
	  }

	  sql.like = function like(col, val, escape_char) { return new Like(col, val, escape_char); };
	  function Like(col, val, escape_char) {
	    this.col = col;
	    this.val = val;
	    this.escape_char = escape_char;
	  }
	  sql.Like = Like;
	  Like.prototype.clone = function clone() {
	    return new Like(this.col, this.val, this.escape_char);
	  };
	  Like.prototype.toString = function toString(opts) {
	    var sql = handleColumn(this.col, opts) + ' LIKE ' + handleValue(this.val, opts);
	    if (this.escape_char)
	      sql += " ESCAPE '" + this.escape_char + "'";
	    return sql;
	  }

	  sql.between = function between(col, val1, val2) { return new Between(col, val1, val2); };
	  function Between(col, val1, val2) {
	    this.col = col;
	    this.val1 = val1;
	    this.val2 = val2;
	  }
	  sql.Between = Between;
	  Between.prototype.clone = function clone() {
	    return new Between(this.col, this.val1, this.val2);
	  };
	  Between.prototype.toString = function(opts) {
	    return handleColumn(this.col, opts) + ' BETWEEN ' + handleValue(this.val1, opts) + ' AND ' + handleValue(this.val2, opts);
	  };

	  sql.isNull = function isNull(col) { return new Unary('IS NULL', col); };
	  sql.isNotNull = function isNotNull(col) { return new Unary('IS NOT NULL', col); };

	  function Unary(op, col) {
	    this.op = op;
	    this.col = col;
	  }
	  sql.Unary = Unary;
	  Unary.prototype.clone = function clone() {
	    return new Unary(this.op, this.col);
	  };
	  Unary.prototype.toString = function toString(opts) {
	    return handleColumn(this.col, opts) + ' ' + this.op;
	  };

	  sql['in'] = function(col, list) {
	    if (_.isArray(list) || list instanceof Statement)
	      return new In(col, list);
	    else
	      return new In(col, _.toArray(arguments).slice(1));
	  };

	  function In(col, list) {
	    this.col = col;
	    this.list = list;
	  }
	  sql.In = In;
	  In.prototype.clone = function clone() {
	    return new In(this.col, this.list.slice());
	  };
	  In.prototype.toString = function toString(opts) {
	    var col_sql = handleColumn(this.col, opts);
	    var sql;
	    if (_.isArray(this.list))
	      sql = handleValues(this.list, opts).join(', ');
	    else if (this.list instanceof Statement)
	      sql = this.list._toString(opts);
	    
	    return col_sql + ' IN (' + sql + ')';
	  };

	  sql.exists = function(subquery) { return new Exists(subquery); }
	  function Exists(subquery) {
	    this.subquery = subquery;
	  };
	  sql.Exists = Exists;
	  Exists.prototype.clone = function clone() {
	    return new Exists(this.subquery.clone());
	  };
	  Exists.prototype.toString = function toString(opts) {
	    return 'EXISTS (' + this.subquery._toString(opts) + ')';
	  };


	  function getAlias(tbl) {
	    var separator = ' AS ';
	    var sep_ix = tbl.indexOf(separator);
	    if (sep_ix == -1) {
	      separator = ' ';
	      sep_ix = tbl.indexOf(separator);
	    }
	    if (sep_ix > -1)
	      return tbl.slice(sep_ix + separator.length);
	    return tbl;
	  }
	  function getTable(tbl) {
	    var space_ix = tbl.indexOf(' ');
	    if (space_ix > -1)
	      tbl = tbl.slice(0, space_ix);
	    if (tbl[0] == '"' && tbl[tbl.length - 1] == '"')
	      tbl = tbl.slice(1, -1);
	    return tbl;
	  }

	  function isExpr(expr) {
	    return expr instanceof sql || expr instanceof Group || expr instanceof Not || expr instanceof Binary || expr instanceof Unary || expr instanceof In || expr instanceof Like || expr instanceof Between || expr instanceof Exists;
	  }

	  // raw objects default to equals
	  // {first_name: 'Fred', last_name = 'Flintstone'} ->
	  //   [equals('first_name', 'Fred'), equals('last_name', 'Flintstone')]
	  function objToEquals(obj) {
	    var expressions = [];
	    for (var col in obj) {
	      expressions.push(sql.equal(col, obj[col]));
	    }
	    return expressions;
	  }

	  function handleExpression(expr, opts) {
	    expr.parens = false;
	    if (expr.expressions && expr.expressions.length == 1)
	      expr.expressions[0].parens = false;
	    return expr.toString(opts);
	  }
	  sql._handleExpression = handleExpression;

	  function handleValues(vals, opts) {
	    return vals.map(function(val) {
	      return handleValue(val, opts);
	    });
	  }
	  sql._handleValues = handleValues;

	  function handleValue(val, opts) {
	    if (val instanceof Statement)
	      return '(' + val._toString(opts) + ')';

	    if (val instanceof sql)
	      return val.toString(opts);

	    if (opts.parameterized) {
	      opts.values.push(val);
	      return opts.placeholder.replace('%d', opts.value_ix++);
	    }

	    return sql.convert(val);
	  }
	  sql._handleValue = handleValue;

	  sql.convert = function(val) {
	    for (var type in sql.conversions)
	      if (_['is' + type].call(_, val))
	        return sql.conversions[type](val);

	    throw new Error('value is of an unsupported type and cannot be converted to SQL: ' + val);
	  }

	  sql.conversions = {
	    'String': function(str) { return "'" + str.replace(/'/g, "''") + "'"; },
	    'Null': function() { return 'null'; },
	    'Undefined': function() { return 'null'; },
	    'Number': function(num) { return num.toString(); },
	    'Boolean': function(bool) { return bool.toString().toUpperCase(); },
	    'Date': function(dt) { return "TIMESTAMP WITH TIME ZONE '" + dt.toISOString().replace('T', ' ').replace('Z', '+00:00') + "'"; },
	    'Array': function(arr) { return '{' + arr.map(sql.convert).join(', ') + '}'; }
	  };

	  function handleTables(tables, opts) {
	    return tables.map(function(tbl) { return handleTable(tbl, opts); }).join(', ');
	  }
	  sql._handleTables = handleTables;

	  function handleTable(table, opts) {
	    return handleColumn(expandAlias(table), opts);
	  }
	  sql._handleTable = handleTable;

	  function handleColumns(cols, opts) {
	    return cols.map(function(col) { return handleColumn(col, opts); }).join(', ');
	  }
	  sql._handleColumns = handleColumns;

	  // handles prefixes before a '.' and suffixes after a ' '
	  // for example: 'tbl.order AS tbl_order' -> 'tbl."order" AS tbl_order'
	  var unquoted_regex = /^[\w\.]+(( AS)? \w+)?$/i;
	  function handleColumn(expr, opts) {
	    if (expr instanceof Statement)
	      return expr._toNestedString(opts);

	    if (expr instanceof val)
	      return handleValue(expr.val, opts);

	    if (expr instanceof sql)
	      return expr.toString(opts);

	    if (unquoted_regex.test(expr))
	      return quoteColOrTbl(expr);
	    else
	      return expr;
	  }
	  sql._handleColumn = handleColumn;

	  function quoteColOrTbl(expr) {
	    var prefix = '';
	    var dot_ix = expr.lastIndexOf('.');
	    if (dot_ix > -1) {
	      prefix = expr.slice(0, dot_ix);
	      expr = expr.slice(dot_ix + 1);
	    }

	    var suffix = '';
	    var space_ix = expr.indexOf(' ');
	    if (space_ix > -1) {
	      suffix = expr.slice(space_ix);
	      expr = expr.slice(0, space_ix);
	    }

	    return (prefix ? autoQuote(prefix) + '.' : '') + autoQuote(expr) + suffix;
	  }
	  sql._quoteColOrTbl = quoteColOrTbl;

	  // auto-quote tbl & col names if they have caps or are reserved words
	  sql._autoQuoteChar = '"';
	  
	  function autoQuote(str) {
	    if (/^\w+$/.test(str) && (/[A-Z]/.test(str) || str in reserved))
	      return sql._autoQuoteChar + str + sql._autoQuoteChar;
	    return str;
	  }
	  sql._autoQuote = autoQuote;

	  // Postgres: Table C-1 of http://www.postgresql.org/docs/9.3/static/sql-keywords-appendix.html
	  // SQLite: http://www.sqlite.org/lang_keywords.html
	  var reserved = ['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization', 'both', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'constraint', 'create', 'cross', 'current_catalog', 'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer', 'over', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select', 'session_user', 'similar', 'some', 'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when', 'where', 'window', 'with', 'abort', 'action', 'add', 'after', 'all', 'alter', 'analyze', 'and', 'as', 'asc', 'attach', 'autoincrement', 'before', 'begin', 'between', 'by', 'cascade', 'case', 'cast', 'check', 'collate', 'column', 'commit', 'conflict', 'constraint', 'create', 'cross', 'current_date', 'current_time', 'current_timestamp', 'database', 'default', 'deferrable', 'deferred', 'delete', 'desc', 'detach', 'distinct', 'drop', 'each', 'else', 'end', 'escape', 'except', 'exclusive', 'exists', 'explain', 'fail', 'for', 'foreign', 'from', 'full', 'glob', 'group', 'having', 'if', 'ignore', 'immediate', 'in', 'index', 'indexed', 'initially', 'inner', 'insert', 'instead', 'intersect', 'into', 'is', 'isnull', 'join', 'key', 'left', 'like', 'limit', 'match', 'natural', 'no', 'not', 'notnull', 'null', 'of', 'offset', 'on', 'or', 'order', 'outer', 'plan', 'pragma', 'primary', 'query', 'raise', 'references', 'regexp', 'reindex', 'release', 'rename', 'replace', 'restrict', 'right', 'rollback', 'row', 'savepoint', 'select', 'set', 'table', 'temp', 'temporary', 'then', 'to', 'transaction', 'trigger', 'union', 'unique', 'update', 'using', 'vacuum', 'values', 'view', 'virtual', 'when', 'where'];
	  reserved = _.object(reserved, reserved);
	  sql._reserved = reserved;

	  function isPlainObject(val) {
	    return _.isObject(val) && !_.isArray(val);
	  }


	  // optional conveniences
	  sql._aliases = {};
	  sql.aliasExpansions = function aliasExpansions(aliases) {
	    sql._aliases = aliases;
	  }
	  function expandAlias(tbl) {
	    return typeof tbl == 'string' && tbl in sql._aliases ? sql._aliases[tbl] + ' ' + tbl : tbl;
	  }

	  sql.joinCriteria = function joinCriteria(fn) {
	    if (!fn) return sql._joinCriteria;
	    sql._joinCriteria = fn;
	  };


	  // uber-simple mini-templating language to make it easy to define clauses
	  // handlebars-like syntax, supports helpers and nested blocks
	  // does not support context changes, the dot operator on properties or HTML escaping
	  function templ(str, ctx, opts) {
	    var result = '';
	    var lastIndex = 0;

	    var tmpl_re = /\{\{([#\/])?(\w+) ?(\w+)?\}\}/g;
	    var m;
	    while (m = tmpl_re.exec(str)) {
	      var is_block = m[1];
	      var is_start = m[1] == '#';
	      if (m[3]) {
	        var fn_name = m[2], attr = m[3];
	        var helper = templ.helpers[fn_name];
	      }
	      else {
	        var attr = m[2];
	      }
	      var val = ctx[attr];
	      result += str.slice(lastIndex, m.index);

	      if (is_block) {
	        if (is_start) {
	          var end_re = new RegExp("\\{\\{([#/])" + fn_name + ' ?(\\w+)?\\}\\}', 'g');
	          end_re.lastIndex = tmpl_re.lastIndex;
	          // incr & decr level 'til we find the end block that matches this start block
	          var level = 1;
	          while (level) {
	            var end_m = end_re.exec(str);
	            if (!end_m)
	              throw new Error('End not found for block ' + fn_name);
	            if (end_m[1] == '#')
	              level++;
	            else
	              level--;
	          }
	          var contents = str.slice(tmpl_re.lastIndex, end_m.index);
	          result += helper.call(ctx, val, opts, contents, ctx);
	          lastIndex = tmpl_re.lastIndex = end_re.lastIndex;
	        }
	      }
	      else {
	        if (fn_name)
	          result += helper.call(ctx, val, opts);
	        else
	          result += val;
	        lastIndex = tmpl_re.lastIndex;
	      }
	    }
	    result += str.slice(lastIndex);
	    return result;
	  }
	  sql.templ = templ;

	  templ.helpers = {
	    'if': function(val, opts, contents, ctx) { return val ? templ(contents, ctx, opts) : ''; },
	    'ifNotNull': function(val, opts, contents, ctx) { return val != null ? templ(contents, ctx, opts) : ''; },
	    'columns': handleColumns,
	    'table': handleTable,
	    'tables': handleTables,
	    'expression': handleExpression
	  };

	  // provided for browser support, based on https://gist.github.com/prust/5936064
	  function inherits(ctor, superCtor) {
	    function noop() {};

	    if (Object.create) {
	      ctor.super_ = superCtor;
	      ctor.prototype = Object.create(superCtor.prototype, {
	          constructor: {
	              value: ctor,
	              enumerable: false,
	              writable: true,
	              configurable: true
	          }
	      });
	    }
	    else {
	      noop.prototype = superCtor.prototype;
	      ctor.super_ = superCtor;
	      ctor.prototype = new noop;
	      ctor.prototype.constructor = ctor;
	    }
	    return ctor;
	  }
	  sql.inherits = inherits;

	  sql._extension = function () {
	    var ext = subclass(sql);

	    _.forEach(_.keys(sql), function(prop_name) {
	      ext[prop_name] = sql[prop_name];
	    });

	    ['select', 'insert', 'update', 'delete'].forEach(function (stmt) {
	      var cls = sql[stmt];
	      ext[stmt] = subclass(cls);
	      ext[stmt].defineClause = cls.defineClause;
	      ext[stmt].prototype.clauses = cls.prototype.clauses.slice();
	    });
	    ext.insertInto = ext.insert;
	    ext.deleteFrom = ext.delete;

	    return ext;
	  }

	  function subclass(base) {
	    function cls() {
	      if (!(this instanceof cls))
	        return applyNew(cls, arguments);
	      
	      base.apply(this, arguments);
	    }
	    return inherits(cls, base);
	  }

	  // http://stackoverflow.com/a/8843181/194758
	  function applyNew(cls, args) {
	    args = _.toArray(args);
	    args.unshift(null);
	    return new (cls.bind.apply(cls, args));
	  }

	  if (is_common_js)
	    module.exports = sql;
	  else
	    window.SqlBricks = sql;

	})();


/***/ },
/* 2 */
/***/ function(module, exports) {

	module.exports = require("underscore");

/***/ },
/* 3 */
/***/ function(module, exports) {

	module.exports = require("pg");

/***/ },
/* 4 */
/***/ function(module, exports) {

	module.exports = require("auth0@2.1.0");

/***/ },
/* 5 */
/***/ function(module, exports) {

	module.exports = require("async");

/***/ },
/* 6 */
/***/ function(module, exports) {

	module.exports = require("moment");

/***/ },
/* 7 */
/***/ function(module, exports) {

	module.exports = require("useragent");

/***/ },
/* 8 */
/***/ function(module, exports) {

	module.exports = require("express");

/***/ },
/* 9 */
/***/ function(module, exports, __webpack_require__) {

	exports.fromConnect = exports.fromExpress = fromConnect;
	exports.fromHapi = fromHapi;
	exports.fromServer = exports.fromRestify = fromServer;


	// API functions

	function fromConnect (connectFn) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return connectFn(req, res);
	    };
	}

	function fromHapi(server) {
	    var webtaskContext;

	    server.ext('onRequest', function (request, response) {
	        var normalizeRouteRx = createRouteNormalizationRx(request.x_wt.jtn);

	        request.setUrl(request.url.replace(normalizeRouteRx, '/'));
	        request.webtaskContext = webtaskContext;
	    });

	    return function (context, req, res) {
	        var dispatchFn = server._dispatch();

	        webtaskContext = attachStorageHelpers(context);

	        dispatchFn(req, res);
	    };
	}

	function fromServer(httpServer) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return httpServer.emit('request', req, res);
	    };
	}


	// Helper functions

	function createRouteNormalizationRx(jtn) {
	    var normalizeRouteBase = '^\/api\/run\/[^\/]+\/';
	    var normalizeNamedRoute = '(?:[^\/\?#]*\/?)?';

	    return new RegExp(
	        normalizeRouteBase + (
	        jtn
	            ?   normalizeNamedRoute
	            :   ''
	    ));
	}

	function attachStorageHelpers(context) {
	    context.read = context.secrets.EXT_STORAGE_URL
	        ?   readFromPath
	        :   readNotAvailable;
	    context.write = context.secrets.EXT_STORAGE_URL
	        ?   writeToPath
	        :   writeNotAvailable;

	    return context;


	    function readNotAvailable(path, options, cb) {
	        var Boom = __webpack_require__(10);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function readFromPath(path, options, cb) {
	        var Boom = __webpack_require__(10);
	        var Request = __webpack_require__(11);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'GET',
	            headers: options.headers || {},
	            qs: { path: path },
	            json: true,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode === 404 && Object.hasOwnProperty.call(options, 'defaultValue')) return cb(null, options.defaultValue);
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null, body);
	        });
	    }

	    function writeNotAvailable(path, data, options, cb) {
	        var Boom = __webpack_require__(10);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function writeToPath(path, data, options, cb) {
	        var Boom = __webpack_require__(10);
	        var Request = __webpack_require__(11);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'PUT',
	            headers: options.headers || {},
	            qs: { path: path },
	            body: data,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null);
	        });
	    }
	}


/***/ },
/* 10 */
/***/ function(module, exports) {

	module.exports = require("boom");

/***/ },
/* 11 */
/***/ function(module, exports) {

	module.exports = require("request");

/***/ },
/* 12 */
/***/ function(module, exports) {

	module.exports = require("superagent");

/***/ },
/* 13 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate) {const LRU = __webpack_require__(16);
	const _ = __webpack_require__(17);
	const lru_params =  [ 'max', 'maxAge', 'length', 'dispose', 'stale' ];

	module.exports = function (options) {
	  var cache = new LRU(_.pick(options, lru_params));
	  var load = options.load;
	  var hash = options.hash;

	  var result = function () {
	    var args = _.toArray(arguments);
	    var parameters = args.slice(0, -1);
	    var callback = args.slice(-1).pop();

	    var key;

	    if (parameters.length === 0 && !hash) {
	      //the load function only receives callback.
	      key = '_';
	    } else {
	      key = hash.apply(options, parameters);
	    }

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return setImmediate.apply(null, [callback, null].concat(fromCache));
	    }

	    load.apply(null, parameters.concat(function (err) {
	      if (err) {
	        return callback(err);
	      }

	      cache.set(key, _.toArray(arguments).slice(1));

	      return callback.apply(null, arguments);

	    }));

	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};


	module.exports.sync = function (options) {
	  var cache = new LRU(_.pick(options, lru_params));
	  var load = options.load;
	  var hash = options.hash;

	  var result = function () {
	    var args = _.toArray(arguments);

	    var key = hash.apply(options, args);

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return fromCache;
	    }

	    var result = load.apply(null, args);

	    cache.set(key, result);

	    return result;
	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(14).setImmediate))

/***/ },
/* 14 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate, clearImmediate) {var nextTick = __webpack_require__(15).nextTick;
	var apply = Function.prototype.apply;
	var slice = Array.prototype.slice;
	var immediateIds = {};
	var nextImmediateId = 0;

	// DOM APIs, for completeness

	exports.setTimeout = function() {
	  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
	};
	exports.setInterval = function() {
	  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
	};
	exports.clearTimeout =
	exports.clearInterval = function(timeout) { timeout.close(); };

	function Timeout(id, clearFn) {
	  this._id = id;
	  this._clearFn = clearFn;
	}
	Timeout.prototype.unref = Timeout.prototype.ref = function() {};
	Timeout.prototype.close = function() {
	  this._clearFn.call(window, this._id);
	};

	// Does not start the time, just sets up the members needed.
	exports.enroll = function(item, msecs) {
	  clearTimeout(item._idleTimeoutId);
	  item._idleTimeout = msecs;
	};

	exports.unenroll = function(item) {
	  clearTimeout(item._idleTimeoutId);
	  item._idleTimeout = -1;
	};

	exports._unrefActive = exports.active = function(item) {
	  clearTimeout(item._idleTimeoutId);

	  var msecs = item._idleTimeout;
	  if (msecs >= 0) {
	    item._idleTimeoutId = setTimeout(function onTimeout() {
	      if (item._onTimeout)
	        item._onTimeout();
	    }, msecs);
	  }
	};

	// That's not how node.js implements it but the exposed api is the same.
	exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
	  var id = nextImmediateId++;
	  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

	  immediateIds[id] = true;

	  nextTick(function onNextTick() {
	    if (immediateIds[id]) {
	      // fn.call() is faster so we optimize for the common use-case
	      // @see http://jsperf.com/call-apply-segu
	      if (args) {
	        fn.apply(null, args);
	      } else {
	        fn.call(null);
	      }
	      // Prevent ids from leaking
	      exports.clearImmediate(id);
	    }
	  });

	  return id;
	};

	exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
	  delete immediateIds[id];
	};
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(14).setImmediate, __webpack_require__(14).clearImmediate))

/***/ },
/* 15 */
/***/ function(module, exports) {

	// shim for using process in browser

	var process = module.exports = {};
	var queue = [];
	var draining = false;
	var currentQueue;
	var queueIndex = -1;

	function cleanUpNextTick() {
	    draining = false;
	    if (currentQueue.length) {
	        queue = currentQueue.concat(queue);
	    } else {
	        queueIndex = -1;
	    }
	    if (queue.length) {
	        drainQueue();
	    }
	}

	function drainQueue() {
	    if (draining) {
	        return;
	    }
	    var timeout = setTimeout(cleanUpNextTick);
	    draining = true;

	    var len = queue.length;
	    while(len) {
	        currentQueue = queue;
	        queue = [];
	        while (++queueIndex < len) {
	            if (currentQueue) {
	                currentQueue[queueIndex].run();
	            }
	        }
	        queueIndex = -1;
	        len = queue.length;
	    }
	    currentQueue = null;
	    draining = false;
	    clearTimeout(timeout);
	}

	process.nextTick = function (fun) {
	    var args = new Array(arguments.length - 1);
	    if (arguments.length > 1) {
	        for (var i = 1; i < arguments.length; i++) {
	            args[i - 1] = arguments[i];
	        }
	    }
	    queue.push(new Item(fun, args));
	    if (queue.length === 1 && !draining) {
	        setTimeout(drainQueue, 0);
	    }
	};

	// v8 likes predictible objects
	function Item(fun, array) {
	    this.fun = fun;
	    this.array = array;
	}
	Item.prototype.run = function () {
	    this.fun.apply(null, this.array);
	};
	process.title = 'browser';
	process.browser = true;
	process.env = {};
	process.argv = [];
	process.version = ''; // empty string to avoid regexp issues
	process.versions = {};

	function noop() {}

	process.on = noop;
	process.addListener = noop;
	process.once = noop;
	process.off = noop;
	process.removeListener = noop;
	process.removeAllListeners = noop;
	process.emit = noop;

	process.binding = function (name) {
	    throw new Error('process.binding is not supported');
	};

	process.cwd = function () { return '/' };
	process.chdir = function (dir) {
	    throw new Error('process.chdir is not supported');
	};
	process.umask = function() { return 0; };


/***/ },
/* 16 */
/***/ function(module, exports) {

	module.exports = require("lru-cache");

/***/ },
/* 17 */
/***/ function(module, exports) {

	module.exports = require("lodash");

/***/ }
/******/ ]);