'use strict';

var model = {
  'tableName': 'auth0Logs',
  'tableProperties': {
    'date': {
      'type': 'key'
    },
    'type': { 
      'type': 'string',
      // 'required': true
    },
    'connection': { 
      'type': 'string',
      // 'required': true
    },
    'client_id': { 
      'type': 'string',
      // 'required': true
    },
    'client_name': { 
      'type': 'string',
      // 'required': true
    },
    'user_id': { 
      'type': 'string',
      // 'required': true
    },
    'user_name': { 
      'type': 'string',
      // 'required': true
    }
  }
};

module.exports = model;