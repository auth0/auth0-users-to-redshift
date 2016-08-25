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

	var Loggly = __webpack_require__(1);
	var Auth0 = __webpack_require__(13);
	var async = __webpack_require__(14);
	var moment = __webpack_require__(15);
	var useragent = __webpack_require__(16);
	var express = __webpack_require__(17);
	var Webtask = __webpack_require__(18);
	var app = express();
	var Request = __webpack_require__(20);
	var memoizer = __webpack_require__(21);

	function lastLogCheckpoint(req, res) {
	  var ctx = req.webtaskContext;
	  var required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'LOGGLY_CUSTOMER_TOKEN'];
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

	    var loggly = Loggly.createClient({
	      token: ctx.data.LOGGLY_CUSTOMER_TOKEN,
	      subdomain: ctx.data.LOGGLY_SUBDOMAIN || '-',
	      tags: ['auth0']
	    });

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

	      // loggly
	      loggly.log(context.logs, function (err) {
	        if (err) {
	          console.log('Error sending logs to Sumologic', err);
	          return callback(err);
	        }

	        console.log('Upload complete.');

	        return callback(null, context);
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

	/*
	 * loggly.js: Wrapper for node-loggly object
	 *
	 * (C) 2010 Charlie Robbins
	 * MIT LICENSE
	 *
	 */

	var loggly = exports;

	//
	// Export node-loggly core client APIs
	//
	loggly.version       = __webpack_require__(2).version;
	loggly.createClient  = __webpack_require__(3).createClient;
	loggly.serialize     = __webpack_require__(7).serialize;
	loggly.Loggly        = __webpack_require__(3).Loggly;

	//
	// Export Resources for node-loggly
	//
	loggly.Search = __webpack_require__(10).Search;


/***/ },
/* 2 */
/***/ function(module, exports) {

	module.exports = {
		"name": "loggly",
		"description": "A client implementation for Loggly cloud Logging-as-a-Service API",
		"version": "1.1.0",
		"author": {
			"name": "Charlie Robbins",
			"email": "charlie.robbins@gmail.com"
		},
		"repository": {
			"type": "git",
			"url": "git+ssh://git@github.com/winstonjs/node-loggly.git"
		},
		"keywords": [
			"cloud computing",
			"api",
			"logging",
			"loggly"
		],
		"dependencies": {
			"request": "2.67.x",
			"timespan": "2.3.x",
			"json-stringify-safe": "5.0.x"
		},
		"devDependencies": {
			"common-style": "^3.1.0",
			"vows": "0.8.x"
		},
		"main": "./lib/loggly",
		"scripts": {
			"pretest": "common lib/**/*.js lib/*.js test/helpers.js",
			"test": "vows test/*-test.js --spec"
		},
		"license": "MIT",
		"engines": {
			"node": ">= 0.8.0"
		},
		"gitHead": "5e5ab617ae5ee69dd25ae69c6bdedb1b4098fa46",
		"bugs": {
			"url": "https://github.com/winstonjs/node-loggly/issues"
		},
		"homepage": "https://github.com/winstonjs/node-loggly#readme",
		"_id": "loggly@1.1.0",
		"_shasum": "663e3edb8c880b14ee8950cb35c52e0939c537ae",
		"_from": "loggly@>=1.1.0 <2.0.0",
		"_npmVersion": "2.14.15",
		"_nodeVersion": "4.2.2",
		"_npmUser": {
			"name": "indexzero",
			"email": "charlie.robbins@gmail.com"
		},
		"maintainers": [
			{
				"name": "indexzero",
				"email": "charlie.robbins@gmail.com"
			},
			{
				"name": "jcrugzz",
				"email": "jcrugzz@gmail.com"
			}
		],
		"dist": {
			"shasum": "663e3edb8c880b14ee8950cb35c52e0939c537ae",
			"tarball": "http://registry.npmjs.org/loggly/-/loggly-1.1.0.tgz"
		},
		"directories": {},
		"_resolved": "https://registry.npmjs.org/loggly/-/loggly-1.1.0.tgz",
		"readme": "ERROR: No README data found!"
	};

/***/ },
/* 3 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 * client.js: Core client functions for accessing Loggly
	 *
	 * (C) 2010 Charlie Robbins
	 * MIT LICENSE
	 *
	 */

	var events = __webpack_require__(4),
	    util = __webpack_require__(5),
	    qs = __webpack_require__(6),
	    common = __webpack_require__(7),
	    loggly = __webpack_require__(1),
	    Search = __webpack_require__(10).Search,
	    stringifySafe = __webpack_require__(12);

	function stringify(msg) {
	  var payload;

	  try { payload = JSON.stringify(msg) }
	  catch (ex) { payload = stringifySafe(msg, null, null, noop) }

	  return payload;
	}
	//
	// function createClient (options)
	//   Creates a new instance of a Loggly client.
	//
	exports.createClient = function (options) {
	  return new Loggly(options);
	};

	//
	// ### function Loggly (options)
	// #### @options {Object} Options for this Loggly client
	// ####   @subdomain
	// ####   @token
	// ####   @json
	// ####   @auth
	// ####   @tags
	// Constructor for the Loggly object
	//
	var Loggly = exports.Loggly = function (options) {
	  if (!options || !options.subdomain || !options.token) {
	    throw new Error('options.subdomain and options.token are required.');
	  }

	  events.EventEmitter.call(this);
	  this.subdomain    = options.subdomain;
	  this.token        = options.token;
	  this.host         = options.host || 'logs-01.loggly.com';
	  this.json         = options.json || null;
	  this.auth         = options.auth || null;
	  this.proxy        = options.proxy || null;
	  this.userAgent    = 'node-loggly ' + loggly.version;
	  this.useTagHeader = 'useTagHeader' in options ? options.useTagHeader : true;

	  //
	  // Set the tags on this instance.
	  //
	  this.tags = options.tags
	    ? this.tagFilter(options.tags)
	    : null;

	  var url   = 'https://' + this.host,
	      api   = options.api  || 'apiv2';

	  this.urls = {
	    default: url,
	    log:     [url, 'inputs', this.token].join('/'),
	    bulk:    [url, 'bulk', this.token].join('/'),
	    api:     'https://' + [this.subdomain, 'loggly', 'com'].join('.') + '/' + api
	  };
	};

	//
	// Inherit from events.EventEmitter
	//
	util.inherits(Loggly, events.EventEmitter);

	//
	// ### function log (msg, tags, callback)
	// #### @msg {string|Object} Data to log
	// #### @tags {Array} **Optional** Tags to send with this msg
	// #### @callback {function} Continuation to respond to when complete.
	// Logs the message to the token associated with this instance. If
	// the message is an Object we will attempt to serialize it. If any
	// `tags` are supplied they will be passed via the `X-LOGGLY-TAG` header.
	//  - http://www.loggly.com/docs/api-sending-data/
	//
	Loggly.prototype.log = function (msg, tags, callback) {
	  if (!callback && typeof tags === 'function') {
	    callback = tags;
	    tags = null;
	  }

	  var self = this,
	      logOptions;

	  //
	  // Remark: Have some extra logic for detecting if we want to make a bulk
	  // request to loggly
	  //
	  var isBulk = Array.isArray(msg);
	  function serialize(msg) {
	    if (msg instanceof Object) {
	      return self.json ? stringify(msg) : common.serialize(msg);
	    }
	    else {
	      return self.json ? stringify({ message: msg }) : msg;
	    }
	  }

	  msg = isBulk ? msg.map(serialize).join('\n') : serialize(msg);

	  logOptions = {
	    uri:     isBulk ? this.urls.bulk : this.urls.log,
	    method:  'POST',
	    body:    msg,
	    proxy:   this.proxy,
	    headers: {
	      host:             this.host,
	      accept:           '*/*',
	      'user-agent':     this.userAgent,
	      'content-type':   this.json ? 'application/json' : 'text/plain',
	      'content-length': Buffer.byteLength(msg)
	    }
	  };

	  //
	  // Remark: if tags are passed in run the filter on them and concat
	  // with any tags that were passed or just use default tags if they exist
	  //
	  tags = tags
	    ? (this.tags ? this.tags.concat(this.tagFilter(tags)) : this.tagFilter(tags))
	    : this.tags;

	  //
	  // Optionally send `X-LOGGLY-TAG` if we have them
	  //
	  if (tags) {
	    // Decide whether to add tags as http headers or add them to the URI.
	    if (this.useTagHeader) {
	      logOptions.headers['X-LOGGLY-TAG'] = tags.join(',');
	    }
	    else {
	      logOptions.uri += '/tag/' + tags.join(',') + '/';
	    }
	  }

	  common.loggly(logOptions, callback, function (res, body) {
	    try {
	      var result = JSON.parse(body);
	      self.emit('log', result);
	      if (callback) {
	        callback(null, result);
	      }
	    }
	    catch (ex) {
	      if (callback) {
	        callback(new Error('Unspecified error from Loggly: ' + ex));
	      }
	    }
	  });

	  return this;
	};

	//
	// ### function tag (tags)
	// #### @tags {Array} Tags to use for `X-LOGGLY-TAG`
	// Sets the tags on this instance
	//
	Loggly.prototype.tagFilter = function (tags) {
	  var isSolid = /^[\w\d][\w\d-_.]+/;

	  tags = !Array.isArray(tags)
	    ? [tags]
	    : tags;

	  //
	  // TODO: Filter against valid tag names with some Regex
	  // http://www.loggly.com/docs/tags/
	  // Remark: Docs make me think we dont need this but whatevs
	  //
	  return tags.filter(function (tag) {
	    //
	    // Remark: length may need to use Buffer.byteLength?
	    //
	    return isSolid.test(tag) && tag.length <= 64;
	  });
	};

	//
	// ### function customer (callback)
	// ### @callback {function} Continuation to respond to.
	// Retrieves the customer information from the Loggly API:
	//   - http://www.loggly.com/docs/api-account-info/
	//
	Loggly.prototype.customer = function (callback) {
	  common.loggly({
	    uri: this.logglyUrl('customer'),
	    auth: this.auth
	  }, callback, function (res, body) {
	    var customer;
	    try { customer = JSON.parse(body) }
	    catch (ex) { return callback(ex) }
	    callback(null, customer);
	  });
	};

	//
	// function search (query, callback)
	//   Returns a new search object which can be chained
	//   with options or called directly if @callback is passed
	//   initially.
	//
	// Sample Usage:
	//
	//   client.search('404', function () { /* ... */ })
	//         .on('rsid', function (rsid) { /* ... */ })
	//
	//   client.search({ query: '404', rows: 100 })
	//         .on('rsid', function (rsid) { /* ... */ })
	//         .run(function () { /* ... */ });
	//
	Loggly.prototype.search = function (query, callback) {
	  var options = typeof query === 'string'
	    ? { query: query }
	    : query;

	  options.callback = callback;
	  return new Search(options, this);
	};

	//
	// function logglyUrl ([path, to, resource])
	//   Helper method that concats the string params into a url
	//   to request against a loggly serverUrl.
	//
	Loggly.prototype.logglyUrl = function (/* path, to, resource */) {
	  var args = Array.prototype.slice.call(arguments);
	  return [this.urls.api].concat(args).join('/');
	};

	//
	// Simple noop function for reusability
	//
	function noop() {}


/***/ },
/* 4 */
/***/ function(module, exports) {

	module.exports = require("events");

/***/ },
/* 5 */
/***/ function(module, exports) {

	module.exports = require("util");

/***/ },
/* 6 */
/***/ function(module, exports) {

	module.exports = require("querystring");

/***/ },
/* 7 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 * common.js: Common utility functions for requesting against Loggly APIs
	 *
	 * (C) 2010 Charlie Robbins
	 * MIT LICENSE
	 *
	 */

	var https = __webpack_require__(8),
	    util = __webpack_require__(5),
	    request = __webpack_require__(9),
	    loggly = __webpack_require__(1);

	var common = exports;

	//
	// Failure HTTP Response codes based
	// off Loggly specification.
	//
	var failCodes = common.failCodes = {
	  400: 'Bad Request',
	  401: 'Unauthorized',
	  403: 'Forbidden',
	  404: 'Not Found',
	  409: 'Conflict / Duplicate',
	  410: 'Gone',
	  500: 'Internal Server Error',
	  501: 'Not Implemented',
	  503: 'Throttled'
	};

	//
	// Success HTTP Response codes based
	// off Loggly specification.
	//
	var successCodes = common.successCodes = {
	  200: 'OK',
	  201: 'Created',
	  202: 'Accepted',
	  203: 'Non-authoritative information',
	  204: 'Deleted'
	};

	//
	// Core method that actually sends requests to Loggly.
	// This method is designed to be flexible w.r.t. arguments
	// and continuation passing given the wide range of different
	// requests required to fully implement the Loggly API.
	//
	// Continuations:
	//   1. 'callback': The callback passed into every node-loggly method
	//   2. 'success':  A callback that will only be called on successful requests.
	//                  This is used throughout node-loggly to conditionally
	//                  do post-request processing such as JSON parsing.
	//
	// Possible Arguments (1 & 2 are equivalent):
	//   1. common.loggly('some-fully-qualified-url', auth, callback, success)
	//   2. common.loggly('GET', 'some-fully-qualified-url', auth, callback, success)
	//   3. common.loggly('DELETE', 'some-fully-qualified-url', auth, callback, success)
	//   4. common.loggly({ method: 'POST', uri: 'some-url', body: { some: 'body'} }, callback, success)
	//
	common.loggly = function () {
	  var args = Array.prototype.slice.call(arguments),
	      success = args.pop(),
	      callback = args.pop(),
	      responded,
	      requestBody,
	      headers,
	      method,
	      auth,
	      proxy,
	      uri;

	  //
	  // Now that we've popped off the two callbacks
	  // We can make decisions about other arguments
	  //
	  if (args.length === 1) {
	    if (typeof args[0] === 'string') {
	      //
	      // If we got a string assume that it's the URI
	      //
	      method = 'GET';
	      uri    = args[0];
	    }
	    else {
	      method      = args[0].method || 'GET';
	      uri         = args[0].uri;
	      requestBody = args[0].body;
	      auth        = args[0].auth;
	      headers     = args[0].headers;
	      proxy       = args[0].proxy;
	    }
	  }
	  else if (args.length === 2) {
	    method = 'GET';
	    uri    = args[0];
	    auth   = args[1];
	  }
	  else {
	    method = args[0];
	    uri    = args[1];
	    auth   = args[2];
	  }

	  function onError(err) {
	    if (!responded) {
	      responded = true;
	      if (callback) { callback(err) }
	    }
	  }

	  var requestOptions = {
	    uri: uri,
	    method: method,
	    headers: headers || {},
	    proxy: proxy
	  };

	  if (auth) {
	    requestOptions.headers.authorization = 'Basic ' + new Buffer(auth.username + ':' + auth.password).toString('base64');
	  }

	  if (requestBody) {
	    requestOptions.body = requestBody;
	  }

	  try {
	    request(requestOptions, function (err, res, body) {
	      if (err) {
	        return onError(err);
	      }

	      var statusCode = res.statusCode.toString();
	      if (Object.keys(failCodes).indexOf(statusCode) !== -1) {
	        return onError((new Error('Loggly Error (' + statusCode + '): ' + failCodes[statusCode])));
	      }

	      success(res, body);
	    });
	  }
	  catch (ex) {
	    onError(ex);
	  }
	};

	//
	// ### function serialize (obj, key)
	// #### @obj {Object|literal} Object to serialize
	// #### @key {string} **Optional** Optional key represented by obj in a larger object
	// Performs simple comma-separated, `key=value` serialization for Loggly when
	// logging for non-JSON values.
	//
	common.serialize = function (obj, key) {
	  if (obj === null) {
	    obj = 'null';
	  }
	  else if (obj === undefined) {
	    obj = 'undefined';
	  }
	  else if (obj === false) {
	    obj = 'false';
	  }

	  if (typeof obj !== 'object') {
	    return key ? key + '=' + obj : obj;
	  }

	  var msg = '',
	      keys = Object.keys(obj),
	      length = keys.length;

	  for (var i = 0; i < length; i++) {
	    if (Array.isArray(obj[keys[i]])) {
	      msg += keys[i] + '=[';

	      for (var j = 0, l = obj[keys[i]].length; j < l; j++) {
	        msg += common.serialize(obj[keys[i]][j]);
	        if (j < l - 1) {
	          msg += ', ';
	        }
	      }

	      msg += ']';
	    }
	    else {
	      msg += common.serialize(obj[keys[i]], keys[i]);
	    }

	    if (i < length - 1) {
	      msg += ', ';
	    }
	  }

	  return msg;
	};

	//
	// function clone (obj)
	//   Helper method for deep cloning pure JSON objects
	//   i.e. JSON objects that are either literals or objects (no Arrays, etc)
	//
	common.clone = function (obj) {
	  var clone = {};
	  for (var i in obj) {
	    clone[i] = obj[i] instanceof Object ? common.clone(obj[i]) : obj[i];
	  }

	  return clone;
	};


/***/ },
/* 8 */
/***/ function(module, exports) {

	module.exports = require("https");

/***/ },
/* 9 */
/***/ function(module, exports) {

	module.exports = require("request");

/***/ },
/* 10 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 * search.js: chainable search functions for Loggly
	 *
	 * (C) 2010 Charlie Robbins
	 * MIT LICENSE
	 *
	 */

	var events = __webpack_require__(4),
	    util = __webpack_require__(5),
	    qs = __webpack_require__(6),
	    timespan = __webpack_require__(11),
	    common = __webpack_require__(7);

	//
	// ### function Search (options, client, callback)
	// #### @options {Object} Options for the search instance
	// #### @client {Loggly} Loggly API client
	// Chainable search object for Loggly API
	//
	var Search = exports.Search = function (options, client) {
	  if (!options || (!options.query && !options.q)) {
	    throw new Error('options.query is required to execute a Loggly search.');
	  }

	  events.EventEmitter.call(this);

	  if (options.query) {
	    options.q = options.query;
	    delete options.query;
	  }

	  this.options = options;
	  this.client  = client;

	  //
	  // If we're passed a callback, run immediately.
	  //
	  if (options.callback) {
	    this.callback = options.callback;
	    delete options.callback;
	    this.run();
	  }
	};

	//
	// Inherit from events.EventEmitter
	//
	util.inherits(Search, events.EventEmitter);

	//
	// ### function run (callback)
	// #### @callback {function} Continuation to respond to when complete
	// Runs the search query for for this instance with the query, and
	// other parameters that have been configured on it.
	//
	Search.prototype.run = function (callback) {
	  var self = this,
	      responded;

	  //
	  // Trim the search query
	  //
	  this.options.q.trim();

	  //
	  // Update the callback for this instance if it's passed
	  //
	  this.callback = callback || this.callback;
	  if (!this.callback) {
	    throw new Error('Cannot run search without a callback function.');
	  }

	  //
	  // ### function respond (arguments...)
	  // Responds only once.
	  //
	  function respond() {
	    if (!responded) {
	      responded = true;
	      self.callback.apply(null, arguments);
	    }
	  }

	  //
	  // ### function awaitResults (rsid)
	  // Checks the Loggly API on an interval for the
	  // results from the specified `rsid`.
	  //
	  function awaitResults(rsid) {
	    if (!rsid || !rsid.id) {
	      return respond(rsid);
	    }

	    common.loggly({
	      uri:  self.client.logglyUrl('events?' + qs.stringify({ rsid: rsid.id })),
	      auth: self.client.auth,
	      json: true
	    }, respond, function (res, body) {
	      var results;
	      try { results = JSON.parse(body) }
	      catch (ex) { return respond(ex) }
	      respond(null, results);
	    });
	  }

	  //
	  // Check any time ranges (if supplied) to ensure
	  // they are valid.
	  //
	  this._checkRange();

	  common.loggly({
	    uri:  this.client.logglyUrl('search?' + qs.stringify(this.options)),
	    auth: this.client.auth,
	    json: true
	  }, this.callback, function (res, body) {
	    var rsid;
	    try { rsid = JSON.parse(body).rsid }
	    catch (ex) { rsid = ex }

	    self.emit('rsid', rsid);
	    awaitResults(rsid);
	  });

	  return this;
	};

	//
	// ### function _checkRange ()
	// Checks if the range that has been configured for this
	// instance is valid and updates if it is not.
	//
	Search.prototype._checkRange = function () {
	  if (!this.options.until && !this.options.from) {
	    return;
	  }

	  this.options.until = this.options.until || 'now';
	  this.options.from  = this.options.from  || '-24h';

	  if (!timespan.parseDate(this.options.until)) {
	    this.options.until = 'now';
	  }

	  if (!timespan.parseDate(this.options.from)) {
	    this.options.from = '-24h';
	  }

	  if (timespan.fromDates(this.options.from, this.options.until) < 0
	    || this.options.until === this.options.from) {
	    //
	    // If the length of the timespan for this Search instance is
	    // negative then set it to default values
	    //
	    this.options.until = 'now';
	    this.options.from = '-24h';
	  }

	  return this;
	};


/***/ },
/* 11 */
/***/ function(module, exports) {

	/*
	* JavaScript TimeSpan Library
	*
	* Copyright (c) 2010 Michael Stum, Charlie Robbins
	* 
	* Permission is hereby granted, free of charge, to any person obtaining
	* a copy of this software and associated documentation files (the
	* "Software"), to deal in the Software without restriction, including
	* without limitation the rights to use, copy, modify, merge, publish,
	* distribute, sublicense, and/or sell copies of the Software, and to
	* permit persons to whom the Software is furnished to do so, subject to
	* the following conditions:
	* 
	* The above copyright notice and this permission notice shall be
	* included in all copies or substantial portions of the Software.
	* 
	* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
	* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
	* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
	* NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
	* LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
	* OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
	* WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
	*/

	//
	// ### Time constants
	//
	var msecPerSecond = 1000,
	    msecPerMinute = 60000,
	    msecPerHour = 3600000,
	    msecPerDay = 86400000;

	//
	// ### Timespan Parsers
	//
	var timeSpanWithDays = /^(\d+):(\d+):(\d+):(\d+)(\.\d+)?/,
	    timeSpanNoDays = /^(\d+):(\d+):(\d+)(\.\d+)?/;

	//
	// ### function TimeSpan (milliseconds, seconds, minutes, hours, days)
	// #### @milliseconds {Number} Number of milliseconds for this instance.
	// #### @seconds {Number} Number of seconds for this instance.
	// #### @minutes {Number} Number of minutes for this instance.
	// #### @hours {Number} Number of hours for this instance.
	// #### @days {Number} Number of days for this instance.
	// Constructor function for the `TimeSpan` object which represents a length
	// of positive or negative milliseconds componentized into milliseconds, 
	// seconds, hours, and days.
	//
	var TimeSpan = exports.TimeSpan = function (milliseconds, seconds, minutes, hours, days) {
	  this.msecs = 0;
	  
	  if (isNumeric(days)) {
	    this.msecs += (days * msecPerDay);
	  }
	  
	  if (isNumeric(hours)) {
	    this.msecs += (hours * msecPerHour);
	  }
	  
	  if (isNumeric(minutes)) {
	    this.msecs += (minutes * msecPerMinute);
	  }
	  
	  if (isNumeric(seconds)) {
	    this.msecs += (seconds * msecPerSecond);
	  }
	  
	  if (isNumeric(milliseconds)) {
	    this.msecs += milliseconds;
	  }
	};

	//
	// ## Factory methods
	// Helper methods for creating new TimeSpan objects
	// from various criteria: milliseconds, seconds, minutes,
	// hours, days, strings and other `TimeSpan` instances.
	//

	//
	// ### function fromMilliseconds (milliseconds)
	// #### @milliseconds {Number} Amount of milliseconds for the new TimeSpan instance.
	// Creates a new `TimeSpan` instance with the specified `milliseconds`.
	//
	exports.fromMilliseconds = function (milliseconds) {
	  if (!isNumeric(milliseconds)) { return }
	  return new TimeSpan(milliseconds, 0, 0, 0, 0);
	}

	//
	// ### function fromSeconds (seconds)
	// #### @milliseconds {Number} Amount of seconds for the new TimeSpan instance.
	// Creates a new `TimeSpan` instance with the specified `seconds`.
	//
	exports.fromSeconds = function (seconds) {
	  if (!isNumeric(seconds)) { return }
	  return new TimeSpan(0, seconds, 0, 0, 0);
	};

	//
	// ### function fromMinutes (milliseconds)
	// #### @milliseconds {Number} Amount of minutes for the new TimeSpan instance.
	// Creates a new `TimeSpan` instance with the specified `minutes`.
	//
	exports.fromMinutes = function (minutes) {
	  if (!isNumeric(minutes)) { return }
	  return new TimeSpan(0, 0, minutes, 0, 0);
	};

	//
	// ### function fromHours (hours)
	// #### @milliseconds {Number} Amount of hours for the new TimeSpan instance.
	// Creates a new `TimeSpan` instance with the specified `hours`.
	//
	exports.fromHours = function (hours) {
	  if (!isNumeric(hours)) { return }
	  return new TimeSpan(0, 0, 0, hours, 0);
	};

	//
	// ### function fromDays (days)
	// #### @milliseconds {Number} Amount of days for the new TimeSpan instance.
	// Creates a new `TimeSpan` instance with the specified `days`.
	//
	exports.fromDays = function (days) {
	  if (!isNumeric(days)) { return }
	  return new TimeSpan(0, 0, 0, 0, days);
	};

	//
	// ### function parse (str)
	// #### @str {string} Timespan string to parse.
	// Creates a new `TimeSpan` instance from the specified
	// string, `str`.
	//
	exports.parse = function (str) {
	  var match, milliseconds;
	  
	  function parseMilliseconds (value) {
	    return value ? parseFloat('0' + value) * 1000 : 0;
	  }
	  
	  // If we match against a full TimeSpan: 
	  //   [days]:[hours]:[minutes]:[seconds].[milliseconds]?
	  if ((match = str.match(timeSpanWithDays))) {
	    return new TimeSpan(parseMilliseconds(match[5]), match[4], match[3], match[2], match[1]);
	  }
	  
	  // If we match against a partial TimeSpan:
	  //   [hours]:[minutes]:[seconds].[milliseconds]?
	  if ((match = str.match(timeSpanNoDays))) {
	    return new TimeSpan(parseMilliseconds(match[4]), match[3], match[2], match[1], 0);
	  }
	  
	  return null;
	};

	//
	// List of default singular time modifiers and associated
	// computation algoritm. Assumes in order, smallest to greatest
	// performing carry forward additiona / subtraction for each
	// Date-Time component.
	//
	var parsers = {
	  'milliseconds': {
	    exp: /(\d+)milli(?:second)?[s]?/i,
	    compute: function (delta, computed) {
	      return _compute(delta, computed, {
	        current: 'milliseconds',
	        next: 'seconds', 
	        max: 1000
	      });
	    }
	  },
	  'seconds': {
	    exp: /(\d+)second[s]?/i,
	    compute: function (delta, computed) {
	      return _compute(delta, computed, {
	        current: 'seconds',
	        next: 'minutes', 
	        max: 60
	      });
	    }
	  },
	  'minutes': {
	    exp: /(\d+)minute[s]?/i,
	    compute: function (delta, computed) {
	      return _compute(delta, computed, {
	        current: 'minutes',
	        next: 'hours', 
	        max: 60
	      });
	    }
	  },
	  'hours': {
	    exp: /(\d+)hour[s]?/i,
	    compute: function (delta, computed) {
	      return _compute(delta, computed, {
	        current: 'hours',
	        next: 'days', 
	        max: 24
	      });
	    }
	  },
	  'days': {
	    exp: /(\d+)day[s]?/i,
	    compute: function (delta, computed) {
	      var days     = monthDays(computed.months, computed.years),
	          sign     = delta >= 0 ? 1 : -1,
	          opsign   = delta >= 0 ? -1 : 1,
	          clean    = 0;
	      
	      function update (months) {
	        if (months < 0) { 
	          computed.years -= 1;
	          return 11;
	        }
	        else if (months > 11) { 
	          computed.years += 1;
	          return 0 
	        }
	        
	        return months;
	      }
	      
	      if (delta) {          
	        while (Math.abs(delta) >= days) {
	          computed.months += sign * 1;
	          computed.months = update(computed.months);
	          delta += opsign * days;
	          days = monthDays(computed.months, computed.years);
	        }
	      
	        computed.days += (opsign * delta);
	      }
	      
	      if (computed.days < 0) { clean = -1 }
	      else if (computed.days > months[computed.months]) { clean = 1 }
	      
	      if (clean === -1 || clean === 1) {
	        computed.months += clean;
	        computed.months = update(computed.months);
	        computed.days = months[computed.months] + computed.days;
	      }
	            
	      return computed;
	    }
	  },
	  'months': {
	    exp: /(\d+)month[s]?/i,
	    compute: function (delta, computed) {
	      var round = delta > 0 ? Math.floor : Math.ceil;
	      if (delta) { 
	        computed.years += round.call(null, delta / 12);
	        computed.months += delta % 12;
	      }
	      
	      if (computed.months > 11) {
	        computed.years += Math.floor((computed.months + 1) / 12);
	        computed.months = ((computed.months + 1) % 12) - 1;
	      }
	      
	      return computed;
	    }
	  },
	  'years': {
	    exp: /(\d+)year[s]?/i,
	    compute: function (delta, computed) {
	      if (delta) { computed.years += delta; }
	      return computed;
	    }
	  }
	};

	//
	// Compute the list of parser names for
	// later use.
	//
	var parserNames = Object.keys(parsers);

	//
	// ### function parseDate (str)
	// #### @str {string} String to parse into a date
	// Parses the specified liberal Date-Time string according to
	// ISO8601 **and**:
	//
	// 1. `2010-04-03T12:34:15Z+12MINUTES`
	// 2. `NOW-4HOURS`
	//
	// Valid modifiers for the more liberal Date-Time string(s):
	//
	//     YEAR, YEARS
	//     MONTH, MONTHS
	//     DAY, DAYS
	//     HOUR, HOURS
	//     MINUTE, MINUTES
	//     SECOND, SECONDS
	//     MILLI, MILLIS, MILLISECOND, MILLISECONDS
	//
	exports.parseDate = function (str) {
	  var dateTime = Date.parse(str),
	      iso = '^([^Z]+)',
	      zulu = 'Z([\\+|\\-])?',
	      diff = {},
	      computed,
	      modifiers,
	      sign;

	  //
	  // If Date string supplied actually conforms 
	  // to UTC Time (ISO8601), return a new Date.
	  //
	  if (!isNaN(dateTime)) {
	    return new Date(dateTime);
	  }
	  
	  //
	  // Create the `RegExp` for the end component
	  // of the target `str` to parse.
	  //
	  parserNames.forEach(function (group) {
	    zulu += '(\\d+[a-zA-Z]+)?';
	  });
	  
	  if (/^NOW/i.test(str)) {
	    //
	    // If the target `str` is a liberal `NOW-*`,
	    // then set the base `dateTime` appropriately.
	    //
	    dateTime = Date.now();
	    zulu = zulu.replace(/Z/, 'NOW');
	  }
	  else if (/^\-/.test(str) || /^\+/.test(str)) {
	    dateTime = Date.now();
	    zulu = zulu.replace(/Z/, '');
	  }
	  else {
	    //
	    // Parse the `ISO8601` component, and the end
	    // component from the target `str`.
	    //
	    dateTime = str.match(new RegExp(iso, 'i'));
	    dateTime = Date.parse(dateTime[1]);
	  }
	  
	  //
	  // If there was no match on either part then 
	  // it must be a bad value.
	  //
	  if (!dateTime || !(modifiers = str.match(new RegExp(zulu, 'i')))) {
	    return null;
	  }
	    
	  //
	  // Create a new `Date` object from the `ISO8601`
	  // component of the target `str`.
	  //
	  dateTime = new Date(dateTime);
	  sign = modifiers[1] === '+' ? 1 : -1;
	  
	  //
	  // Create an Object-literal for consistently accessing
	  // the various components of the computed Date.
	  //
	  var computed = {
	    milliseconds: dateTime.getMilliseconds(),
	    seconds: dateTime.getSeconds(),
	    minutes: dateTime.getMinutes(),
	    hours: dateTime.getHours(),
	    days: dateTime.getDate(),
	    months: dateTime.getMonth(),
	    years: dateTime.getFullYear()
	  };
	  
	  //
	  // Parse the individual component spans (months, years, etc)
	  // from the modifier strings that we parsed from the end 
	  // of the target `str`.
	  //
	  modifiers.slice(2).filter(Boolean).forEach(function (modifier) {
	    parserNames.forEach(function (name) {
	      var match;
	      if (!(match = modifier.match(parsers[name].exp))) {
	        return;
	      }
	      
	      diff[name] = sign * parseInt(match[1], 10);
	    })
	  });
	  
	  //
	  // Compute the total `diff` by iteratively computing 
	  // the partial components from smallest to largest.
	  //
	  parserNames.forEach(function (name) {    
	    computed = parsers[name].compute(diff[name], computed);
	  });
	  
	  return new Date(
	    computed.years,
	    computed.months,
	    computed.days,
	    computed.hours,
	    computed.minutes,
	    computed.seconds,
	    computed.milliseconds
	  );
	};

	//
	// ### function fromDates (start, end, abs)
	// #### @start {Date} Start date of the `TimeSpan` instance to return
	// #### @end {Date} End date of the `TimeSpan` instance to return
	// #### @abs {boolean} Value indicating to return an absolute value
	// Returns a new `TimeSpan` instance representing the difference between
	// the `start` and `end` Dates.
	//
	exports.fromDates = function (start, end, abs) {
	  if (typeof start === 'string') {
	    start = exports.parseDate(start);
	  }
	  
	  if (typeof end === 'string') {
	    end = exports.parseDate(end);
	  }
	  
	  if (!(start instanceof Date && end instanceof Date)) {
	    return null;
	  }
	  
	  var differenceMsecs = end.valueOf() - start.valueOf();
	  if (abs) {
	    differenceMsecs = Math.abs(differenceMsecs);
	  }

	  return new TimeSpan(differenceMsecs, 0, 0, 0, 0);
	};

	//
	// ## Module Helpers
	// Module-level helpers for various utilities such as:
	// instanceOf, parsability, and cloning.
	//

	//
	// ### function test (str)
	// #### @str {string} String value to test if it is a TimeSpan
	// Returns a value indicating if the specified string, `str`,
	// is a parsable `TimeSpan` value.
	//
	exports.test = function (str) {
	  return timeSpanWithDays.test(str) || timeSpanNoDays.test(str);
	};

	//
	// ### function instanceOf (timeSpan)
	// #### @timeSpan {Object} Object to check TimeSpan quality.
	// Returns a value indicating if the specified `timeSpan` is
	// in fact a `TimeSpan` instance.
	//
	exports.instanceOf = function (timeSpan) {
	  return timeSpan instanceof TimeSpan;
	};

	//
	// ### function clone (timeSpan)
	// #### @timeSpan {TimeSpan} TimeSpan object to clone.
	// Returns a new `TimeSpan` instance with the same value
	// as the `timeSpan` object supplied.
	//
	exports.clone = function (timeSpan) {
	  if (!(timeSpan instanceof TimeSpan)) { return }
	  return exports.fromMilliseconds(timeSpan.totalMilliseconds());
	};

	//
	// ## Addition
	// Methods for adding `TimeSpan` instances, 
	// milliseconds, seconds, hours, and days to other
	// `TimeSpan` instances.
	//

	//
	// ### function add (timeSpan)
	// #### @timeSpan {TimeSpan} TimeSpan to add to this instance
	// Adds the specified `timeSpan` to this instance.
	//
	TimeSpan.prototype.add = function (timeSpan) {
	  if (!(timeSpan instanceof TimeSpan)) { return }
	  this.msecs += timeSpan.totalMilliseconds();
	};

	//
	// ### function addMilliseconds (milliseconds)
	// #### @milliseconds {Number} Number of milliseconds to add.
	// Adds the specified `milliseconds` to this instance.
	//
	TimeSpan.prototype.addMilliseconds = function (milliseconds) {
	  if (!isNumeric(milliseconds)) { return }
	  this.msecs += milliseconds;
	};

	//
	// ### function addSeconds (seconds)
	// #### @seconds {Number} Number of seconds to add.
	// Adds the specified `seconds` to this instance.
	//
	TimeSpan.prototype.addSeconds = function (seconds) {
	  if (!isNumeric(seconds)) { return }
	  
	  this.msecs += (seconds * msecPerSecond);
	};

	//
	// ### function addMinutes (minutes)
	// #### @minutes {Number} Number of minutes to add.
	// Adds the specified `minutes` to this instance.
	//
	TimeSpan.prototype.addMinutes = function (minutes) {
	  if (!isNumeric(minutes)) { return }
	  this.msecs += (minutes * msecPerMinute);
	};

	//
	// ### function addHours (hours)
	// #### @hours {Number} Number of hours to add.
	// Adds the specified `hours` to this instance.
	//
	TimeSpan.prototype.addHours = function (hours) {
	  if (!isNumeric(hours)) { return }
	  this.msecs += (hours * msecPerHour);
	};

	//
	// ### function addDays (days)
	// #### @days {Number} Number of days to add.
	// Adds the specified `days` to this instance.
	//
	TimeSpan.prototype.addDays = function (days) {
	  if (!isNumeric(days)) { return }
	  this.msecs += (days * msecPerDay);
	};

	//
	// ## Subtraction
	// Methods for subtracting `TimeSpan` instances, 
	// milliseconds, seconds, hours, and days from other
	// `TimeSpan` instances.
	//

	//
	// ### function subtract (timeSpan)
	// #### @timeSpan {TimeSpan} TimeSpan to subtract from this instance.
	// Subtracts the specified `timeSpan` from this instance.
	//
	TimeSpan.prototype.subtract = function (timeSpan) {
	  if (!(timeSpan instanceof TimeSpan)) { return }
	  this.msecs -= timeSpan.totalMilliseconds();
	};

	//
	// ### function subtractMilliseconds (milliseconds)
	// #### @milliseconds {Number} Number of milliseconds to subtract.
	// Subtracts the specified `milliseconds` from this instance.
	//
	TimeSpan.prototype.subtractMilliseconds = function (milliseconds) {
	  if (!isNumeric(milliseconds)) { return }
	  this.msecs -= milliseconds;
	};

	//
	// ### function subtractSeconds (seconds)
	// #### @seconds {Number} Number of seconds to subtract.
	// Subtracts the specified `seconds` from this instance.
	//
	TimeSpan.prototype.subtractSeconds = function (seconds) {
	  if (!isNumeric(seconds)) { return }
	  this.msecs -= (seconds * msecPerSecond);
	};

	//
	// ### function subtractMinutes (minutes)
	// #### @minutes {Number} Number of minutes to subtract.
	// Subtracts the specified `minutes` from this instance.
	//
	TimeSpan.prototype.subtractMinutes = function (minutes) {
	  if (!isNumeric(minutes)) { return }
	  this.msecs -= (minutes * msecPerMinute);
	};

	//
	// ### function subtractHours (hours)
	// #### @hours {Number} Number of hours to subtract.
	// Subtracts the specified `hours` from this instance.
	//
	TimeSpan.prototype.subtractHours = function (hours) {
	  if (!isNumeric(hours)) { return }
	  this.msecs -= (hours * msecPerHour);
	};

	//
	// ### function subtractDays (days)
	// #### @days {Number} Number of days to subtract.
	// Subtracts the specified `days` from this instance.
	//
	TimeSpan.prototype.subtractDays = function (days) {
	  if (!isNumeric(days)) { return }
	  this.msecs -= (days * msecPerDay);
	};

	//
	// ## Getters
	// Methods for retrieving components of a `TimeSpan`
	// instance: milliseconds, seconds, minutes, hours, and days.
	//

	//
	// ### function totalMilliseconds (roundDown)
	// #### @roundDown {boolean} Value indicating if the value should be rounded down.
	// Returns the total number of milliseconds for this instance, rounding down
	// to the nearest integer if `roundDown` is set.
	//
	TimeSpan.prototype.totalMilliseconds = function (roundDown) {
	  var result = this.msecs;
	  if (roundDown === true) {
	    result = Math.floor(result);
	  }
	  
	  return result;
	};

	//
	// ### function totalSeconds (roundDown)
	// #### @roundDown {boolean} Value indicating if the value should be rounded down.
	// Returns the total number of seconds for this instance, rounding down
	// to the nearest integer if `roundDown` is set.
	//
	TimeSpan.prototype.totalSeconds = function (roundDown) {
	  var result = this.msecs / msecPerSecond;
	  if (roundDown === true) {
	    result = Math.floor(result);
	  }
	  
	  return result;
	};

	//
	// ### function totalMinutes (roundDown)
	// #### @roundDown {boolean} Value indicating if the value should be rounded down.
	// Returns the total number of minutes for this instance, rounding down
	// to the nearest integer if `roundDown` is set.
	//
	TimeSpan.prototype.totalMinutes = function (roundDown) {
	  var result = this.msecs / msecPerMinute;
	  if (roundDown === true) {
	    result = Math.floor(result);
	  }
	  
	  return result;
	};

	//
	// ### function totalHours (roundDown)
	// #### @roundDown {boolean} Value indicating if the value should be rounded down.
	// Returns the total number of hours for this instance, rounding down
	// to the nearest integer if `roundDown` is set.
	//
	TimeSpan.prototype.totalHours = function (roundDown) {
	  var result = this.msecs / msecPerHour;
	  if (roundDown === true) {
	    result = Math.floor(result);
	  }
	  
	  return result;
	};

	//
	// ### function totalDays (roundDown)
	// #### @roundDown {boolean} Value indicating if the value should be rounded down.
	// Returns the total number of days for this instance, rounding down
	// to the nearest integer if `roundDown` is set.
	//
	TimeSpan.prototype.totalDays = function (roundDown) {
	  var result = this.msecs / msecPerDay;
	  if (roundDown === true) {
	    result = Math.floor(result);
	  }
	  
	  return result;
	};

	//
	// ### @milliseconds
	// Returns the length of this `TimeSpan` instance in milliseconds.
	//
	TimeSpan.prototype.__defineGetter__('milliseconds', function () {
	  return this.msecs % 1000;
	});

	//
	// ### @seconds
	// Returns the length of this `TimeSpan` instance in seconds.
	//
	TimeSpan.prototype.__defineGetter__('seconds', function () {
	  return Math.floor(this.msecs / msecPerSecond) % 60;
	});

	//
	// ### @minutes
	// Returns the length of this `TimeSpan` instance in minutes.
	//
	TimeSpan.prototype.__defineGetter__('minutes', function () {
	  return Math.floor(this.msecs / msecPerMinute) % 60;
	});

	//
	// ### @hours
	// Returns the length of this `TimeSpan` instance in hours.
	//
	TimeSpan.prototype.__defineGetter__('hours', function () {
	  return Math.floor(this.msecs / msecPerHour) % 24;
	});

	//
	// ### @days
	// Returns the length of this `TimeSpan` instance in days.
	//
	TimeSpan.prototype.__defineGetter__('days', function () {
	  return Math.floor(this.msecs / msecPerDay);
	});

	//
	// ## Instance Helpers
	// Various help methods for performing utilities
	// such as equality and serialization
	//

	//
	// ### function equals (timeSpan)
	// #### @timeSpan {TimeSpan} TimeSpan instance to assert equal
	// Returns a value indicating if the specified `timeSpan` is equal
	// in milliseconds to this instance.
	//
	TimeSpan.prototype.equals = function (timeSpan) {
	  if (!(timeSpan instanceof TimeSpan)) { return }
	  return this.msecs === timeSpan.totalMilliseconds();
	};

	//
	// ### function toString () 
	// Returns a string representation of this `TimeSpan`
	// instance according to current `format`.
	//
	TimeSpan.prototype.toString = function () {
	  if (!this.format) { return this._format() }
	  return this.format(this);
	};

	//
	// ### @private function _format () 
	// Returns the default string representation of this instance.
	//
	TimeSpan.prototype._format = function () {
	  return [
	    this.days,
	    this.hours,
	    this.minutes,
	    this.seconds + '.' + this.milliseconds
	  ].join(':')
	};

	//
	// ### @private function isNumeric (input) 
	// #### @input {Number} Value to check numeric quality of.
	// Returns a value indicating the numeric quality of the 
	// specified `input`.
	//
	function isNumeric (input) {
	  return input && !isNaN(parseFloat(input)) && isFinite(input);
	};

	//
	// ### @private function _compute (delta, date, computed, options)
	// #### @delta {Number} Channge in this component of the date
	// #### @computed {Object} Currently computed date.
	// #### @options {Object} Options for the computation
	// Performs carry forward addition or subtraction for the
	// `options.current` component of the `computed` date, carrying 
	// it forward to `options.next` depending on the maximum value,
	// `options.max`.
	//
	function _compute (delta, computed, options) {
	  var current = options.current,
	      next    = options.next,
	      max     = options.max,
	      round  = delta > 0 ? Math.floor : Math.ceil;
	      
	  if (delta) {
	    computed[next] += round.call(null, delta / max);
	    computed[current] += delta % max;
	  }
	  
	  if (Math.abs(computed[current]) >= max) {
	    computed[next] += round.call(null, computed[current] / max)
	    computed[current] = computed[current] % max;
	  }

	  return computed;
	}


	//
	// ### @private monthDays (month, year)
	// #### @month {Number} Month to get days for.
	// #### @year {Number} Year of the month to get days for.
	// Returns the number of days in the specified `month` observing
	// leap years.
	//
	var months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	function monthDays (month, year) {    
	  if (((year % 100 !== 0 && year % 4 === 0) 
	    || year % 400 === 0) && month === 1) {
	    return 29;
	  }
	  
	  return months[month];
	}

/***/ },
/* 12 */
/***/ function(module, exports) {

	module.exports = require("json-stringify-safe");

/***/ },
/* 13 */
/***/ function(module, exports) {

	module.exports = require("auth0@2.1.0");

/***/ },
/* 14 */
/***/ function(module, exports) {

	module.exports = require("async");

/***/ },
/* 15 */
/***/ function(module, exports) {

	module.exports = require("moment");

/***/ },
/* 16 */
/***/ function(module, exports) {

	module.exports = require("useragent");

/***/ },
/* 17 */
/***/ function(module, exports) {

	module.exports = require("express");

/***/ },
/* 18 */
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
	        var Boom = __webpack_require__(19);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function readFromPath(path, options, cb) {
	        var Boom = __webpack_require__(19);
	        var Request = __webpack_require__(9);

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
	        var Boom = __webpack_require__(19);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function writeToPath(path, data, options, cb) {
	        var Boom = __webpack_require__(19);
	        var Request = __webpack_require__(9);

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
/* 19 */
/***/ function(module, exports) {

	module.exports = require("boom");

/***/ },
/* 20 */
/***/ function(module, exports) {

	module.exports = require("superagent");

/***/ },
/* 21 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate) {const LRU = __webpack_require__(24);
	const _ = __webpack_require__(25);
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
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(22).setImmediate))

/***/ },
/* 22 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate, clearImmediate) {var nextTick = __webpack_require__(23).nextTick;
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
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(22).setImmediate, __webpack_require__(22).clearImmediate))

/***/ },
/* 23 */
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
/* 24 */
/***/ function(module, exports) {

	module.exports = require("lru-cache");

/***/ },
/* 25 */
/***/ function(module, exports) {

	module.exports = require("lodash");

/***/ }
/******/ ]);