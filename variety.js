/* Variety: A MongoDB Schema Analyzer

This tool helps you get a sense of your application's schema, as well as any
outliers to that schema. Particularly useful when you inherit a codebase with
data dump and want to quickly learn how the data's structured. Also useful for
finding rare keys.

Please see https://github.com/variety/variety for details.

Released by Maypop Inc, © 2012-2016, under the MIT License. */

(function () {
  'use strict'; // wraps everything for which we can use strict mode -JC

  var log = function(message) {
    if(!__quiet) { // mongo shell param, coming from https://github.com/mongodb/mongo/blob/5fc306543cd3ba2637e5cb0662cc375f36868b28/src/mongo/shell/dbshell.cpp#L624
      print(message);
    }
  };

  var dbs = [];
  var emptyDbs = [];

  if (typeof slaveOk !== 'undefined') {
    if (slaveOk === true) {
      db.getMongo().setSlaveOk();
    }
  }

  var knownDatabases = db.adminCommand('listDatabases').databases;
  if(typeof knownDatabases !== 'undefined') { // not authorized user receives error response (json) without databases key
    knownDatabases.forEach(function(d){
      if(db.getSisterDB(d.name).getCollectionNames().length > 0) {
        dbs.push(d.name);
      }
      if(db.getSisterDB(d.name).getCollectionNames().length === 0) {
        emptyDbs.push(d.name);
      }
    });

    if (emptyDbs.indexOf(db.getName()) !== -1) {
      throw 'The database specified ('+ db +') is empty.\n'+
          'Possible database options are: ' + dbs.join(', ') + '.';
    }

    if (dbs.indexOf(db.getName()) === -1) {
      throw 'The database specified ('+ db +') does not exist.\n'+
          'Possible database options are: ' + dbs.join(', ') + '.';
    }
  }

  var collNames = db.getCollectionNames().join(', ');
  if (typeof collection === 'undefined') {
    throw 'You have to supply a \'collection\' variable, à la --eval \'var collection = "animals"\'.\n'+
        'Possible collection options for database specified: ' + collNames + '.\n'+
        'Please see https://github.com/variety/variety for details.';
  }

  if (db[collection].count() === 0) {
    throw 'The collection specified (' + collection + ') in the database specified ('+ db +') does not exist or is empty.\n'+
        'Possible collection options for database specified: ' + collNames + '.';
  }

  var readConfig = function(configProvider) {
    var config = {};
    var read = function(name, defaultValue) {
      var value = typeof configProvider[name] !== 'undefined' ? configProvider[name] : defaultValue;
      config[name] = value;
    };
    read('collection', null);
    read('query', {});
    read('limit', db[config.collection].find(config.query).count());
    read('maxDepth', 99);
    read('sort', {_id: -1});
    read('outputFormat', 'ascii');
    read('persistResults', true);
    read('resultsDatabase', 'varietyResults');
    read('resultsCollection', collection + 'Keys');
    read('resultsUser', null);
    read('resultsPass', null);
    read('logKeysContinuously', false);
    read('excludeSubkeys', []);
    read('arrayEscape', 'XX');

    //Translate excludeSubkeys to set like object... using an object for compatibility...
    config.excludeSubkeys = config.excludeSubkeys.reduce(function (result, item) { result[item+'.'] = true; return result; }, {});

    return config;
  };

  var config = readConfig(this);

  var PluginsClass = function(context) {
    var parsePath = function(val) { return val.slice(-3) !== '.js' ? val + '.js' : val;};
    var parseConfig = function(val) {
      var config = {};
      val.split('&').reduce(function(acc, val) {
        var parts = val.split('=');
        acc[parts[0]] = parts[1];
        return acc;
      }, config);
      return config;
    };

    if(typeof context.plugins !== 'undefined') {
      this.plugins = context.plugins.split(',')
      .map(function(path){return path.trim();})
      .map(function(definition){
        var path = parsePath(definition.split('|')[0]);
        var config = parseConfig(definition.split('|')[1] || '');
        context.module = context.module || {};
        load(path);
        var plugin = context.module.exports;
        plugin.path = path;
        if(typeof plugin.init === 'function') {
          plugin.init(config);
        }
        return plugin;
      }, this);
    } else {
      this.plugins = [];
    }

    this.execute = function(methodName) {
      var args = Array.prototype.slice.call(arguments, 1);
      var applicablePlugins = this.plugins.filter(function(plugin){return typeof plugin[methodName] === 'function';});
      return applicablePlugins.map(function(plugin) {
        return plugin[methodName].apply(plugin, args);
      });
    };

  };

  var $plugins = new PluginsClass(this);
  $plugins.execute('onConfig', config);

  var varietyTypeOf = function(thing) {

    if (typeof thing === 'undefined') { 
      return 'undefined';
    }
    

    if (typeof thing !== 'object') {
    // the messiness below capitalizes the first letter, so the output matches
    // the other return values below. -JC
      var typeofThing = typeof thing; // edgecase of JSHint's "singleGroups"
      return typeofThing[0].toUpperCase() + typeofThing.slice(1);
    } else {
      if (thing && thing.constructor === Array) {
        return 'Array';
      } else if (thing === null) {
        return 'null';
      } else if (thing instanceof Date) {
        return 'Date';
      } else if(thing instanceof NumberLong) {
        return 'NumberLong';
      } else if (thing instanceof ObjectId) {
        return 'ObjectId';
      } else if (thing instanceof BinData) {
        return 'BinData';
      } else {
        return 'Object';
      }
    }
  };

  //flattens object keys to 1D. i.e. {'key1':1,{'key2':{'key3':2}}} becomes {'key1':1,'key2.key3':2}
  //we assume no '.' characters in the keys, which is an OK assumption for MongoDB
  var serializeDoc = function(doc, maxDepth, excludeSubkeys) {
    var result = {};

    //determining if an object is a Hash vs Array vs something else is hard
    //returns true, if object in argument may have nested objects and makes sense to analyse its content
    function isHash(v) {
      var isArray = Array.isArray(v);
      var isObject = typeof v === 'object';
      var specialObject = v instanceof Date ||
                        v instanceof ObjectId ||
                        v instanceof BinData ||
                        v instanceof NumberLong;
      return !specialObject && (isArray || isObject);
    }

    var arrayRegex = new RegExp('\\.' + config.arrayEscape + '\\d+' + config.arrayEscape + '\\.', 'g');

    function serialize(document, parentKey, maxDepth) {
      if(Object.prototype.hasOwnProperty.call(excludeSubkeys, parentKey.replace(arrayRegex, '.')))
        return;
      for(var key in document) {
        //skip over inherited properties such as string, length, etch
        if(!document.hasOwnProperty(key)) {
          continue;
        }
        var value = document[key];
        if(Array.isArray(document))
          key = config.arrayEscape + key + config.arrayEscape; //translate unnamed object key from {_parent_name_}.{_index_} to {_parent_name_}.arrayEscape{_index_}arrayEscape.
        result[parentKey+key] = value;
        //it's an object, recurse...only if we haven't reached max depth
        if(isHash(value) && maxDepth > 1) {
          serialize(value, parentKey+key+'.', maxDepth-1);
        }
      }
    }
    serialize(doc, '', maxDepth);
    return result;
  };

  var serializeDocterark = function(doc, maxDepth) {
	  var result = {};

	  //determining if an object is a Hash vs Array vs something else is hard
	  //returns true, if object in argument may have nested objects and makes sense to analyse its content
	  function isHash(v) {
		  var isArray = Array.isArray(v);
		  var isObject = typeof v === 'object';
		  var specialObject = v instanceof Date ||
			  v instanceof ObjectId ||
			  v instanceof BinData;
		  return !specialObject && (isArray || isObject);
	  }

	  function serializeterark(document, parentKey, maxDepth){
		  for(var key in document){
			  //skip over inherited properties such as string, length, etch
			  if(!document.hasOwnProperty(key)) {
				  continue;
			  }
			  var value = document[key];
			  //objects are skipped here and recursed into later
			  //if(typeof value != 'object')
			  result[parentKey+key] = value;
		  }
	  }
	  serializeterark(doc, '', maxDepth)
	  return result;
  };

  // convert document to key-value map, where value is always an array with types as plain strings
  var analyseDocument = function(document) {
    var result = {};
    var arrayRegex = new RegExp('\\.' + config.arrayEscape + '\\d+' + config.arrayEscape, 'g');
    for (var key in document) {
      var value = document[key];
      key = key.replace(arrayRegex, '.' + config.arrayEscape);
      if(typeof result[key] === 'undefined') {
        result[key] = {};
      }
      var type = varietyTypeOf(value);
      result[key][type] = true;
    }
    return result;
  };

  var analyseDocumentterark = function(document, maxDepth) {
	  var result = {};

	  var recurresult = {};

	  function serializeAValue(value, maxDepth, pararesult) {
		  for(var key in value) {
			  pararesult[key] = {};
			  var tempv = value[key];
			  var type = varietyTypeOf(tempv);
			  if(type == 'Object' && maxDepth > 1) {
				  pararesult[key][type] = {};
				  serializeAValue(tempv, maxDepth-1, pararesult[key][type]);
			  } else {
				  pararesult[key][type]=true; 
			  }
		  }
	  }

	  for (var key in document) {
		  var value = document[key];
		  //translate unnamed object key from {_parent_name_}.{_index_} to {_parent_name_}.XX
		  key = key.replace(/\.\d+/g,'.XX');
		  if(typeof result[key] === 'undefined') {
			  result[key] = {};
		  }
		  var type = varietyTypeOf(value);
		  if (type === "Object") {
			  serializeAValue(value, maxDepth, recurresult);
			  result[key][type] = recurresult;
		  } else {
			  result[key][type] = true;
		  }
	  }
	  return result;
  };


  var mergeDocument = function(docResult, interimResults) {
    for (var key in docResult) {
      if(key in interimResults) {
        var existing = interimResults[key];

        for(var type in docResult[key]) {
          if (type in existing.types) {
            existing.types[type] = existing.types[type] + 1;
          } else {
            existing.types[type] = 1;
            if (config.logKeysContinuously) {
              // log('Found new key type "' + key + '" type "' + type + '"');
            }
          }
        }
        existing.totalOccurrences = existing.totalOccurrences + 1;
      } else {
        var types = {};
        for (var newType in docResult[key]) {
          types[newType] = 1;
          if (config.logKeysContinuously) {
            // log('Found new key type "' + key + '" type "' + newType + '"');
          }
        }
        interimResults[key] = {'types': types,'totalOccurrences':1};
      }
    }
  };

  var mergeDocumentterark = function(docResultstrc, interimResultsstrc) {
	  for (var key in docResultstrc) {
		  if(key in interimResultsstrc) {
			  var existing = interimResultsstrc[key];

			  for(var type in docResultstrc[key]) {
				  if (type in existing.types) {
					  existing.types[type] = existing.types[type] + 1;
				  } else {
					  existing.types[type] = 1;
				  }
			  }
			  existing.totalOccurrences = existing.totalOccurrences + 1;
		  } else {
			  var types = {};
			  for (var newType in docResultstrc[key]) {
				  types[newType] = 1;
			  }
			  var value = docResultstrc[key];
			  var temp = Object.keys(value);
			  if (temp == 'Object') {
				  interimResultsstrc[key] = {'types': types,'totalOccurrences':1, value};
			  } else {
				  interimResultsstrc[key] = {'types': types,'totalOccurrences':1};
			  }
		  }
	  }
  };

  var convertSchema = function(interimResultsstrc, documentsCount, nestedschemaset, interimResults) {
	var getKeyType = function(type) {
		var TypeToType = {
			"ObjectId"	:	"Fixed",
			"Boolean"	:	"Uint08",
			"Number"	:	"Sint32",  // here should be modified next
			"NumberLong"	:	"Sint64",
			"Double"	:	"Float64",	
			"Date"		:	"Sint64",
			"Timestamp"	:	"Sint64",
			"BinData"	:	"CarBin",
			"Array"		: 	"CarBin",
			"Object"	:	"CarBin",
			"Regex"		:	"TwoStrZero",
			"String" 	:	"StrZero",
			"undefined"	:	"Binary",
			"Null"		:	"",
			"DBPointer"	:	"StrZero",
			"JavaScript"	:	"StrZero",
			"Symbol"	:	"StrZero",
			"JSWithScope"	:	"StrZero",	
			"MinKey"	:	"",
			"MaxKey"	:	""
		};
		return TypeToType[type];
	}

	var getMongoType = function(type) {
		var TypeToType = {
			"ObjectId"	:	"oid",
			"Boolean"	:	"bool",
			"Number"	:	"int",
			"NumberLong"	:	"long",
			"Double"	:	"double",	
			"Date"		:	"date",
			"Timestamp"	:	"timestamp",
			"BinData"	:	"bindata",
			"Array"		: 	"array",
			"Object"	:	"object",
			"Regex"		:	"regex",
			"String" 	:	"string",
			"DBPointer"	:	"string",
			"JavaScript"	:	"string",
			"Symbol"	:	"string",
			"JSWithScope"	:	"string",	
		};
		return TypeToType[type];
	}

	var columns = {};
	var differfield = {};
	var nestedindex = 1;

	function serializeCValue(value, pararesult) {
		pararesult["nested"] = {};
		for(var key in value) {
			var tempv = value[key];
			var type = Object.keys(tempv);
			if(type == 'Object') {
				pararesult["nested"][key] = {'type':getKeyType(type.toString()), 'mongoType':getMongoType(type.toString())};
				serializeCValue(tempv['Object'], pararesult["nested"][key]);
			} else {
				pararesult["nested"][key] = {'type':getKeyType(type.toString()), 'mongoType':getMongoType(type.toString())};
			}
		}
	}

	for (var key in interimResultsstrc) {
		var entry = interimResultsstrc[key];
		var nested = {};
		var typeKeys = Object.keys(entry.types).toString();
		if (entry.totalOccurrences === documentsCount) {
		  	// all the records containe the field
			if (typeKeys === "ObjectId") {
				// columns[key] = {'type': getKeyType(typeKeys), 'length': 12};
				columns[key] = {'type': getKeyType(typeKeys), 'length': 12, 'mongoType':getMongoType(typeKeys)};
			} else if (typeKeys === "Object") {
				serializeCValue(entry["value"]['Object'], nested);
				var k = Object.keys(nested);
				var nested = nested[k.toString()];
				columns[key] = {'type': getKeyType(typeKeys), 'mongoType':getMongoType(typeKeys), nested};
			} else {
				// columns[key] = {'type': getKeyType(typeKeys)};
				columns[key] = {'type': getKeyType(typeKeys), 'mongoType':getMongoType(typeKeys)};
			}
		} else {
			// just some records containe the field
			if (typeKeys === "Object") {
				// object structure ==> nestedschemaset
				var tempnestedschemaset = {};
				serializeCValue(entry["value"]['Object'], tempnestedschemaset);
				var k = Object.keys(tempnestedschemaset);
				tempnestedschemaset = tempnestedschemaset[k.toString()];
				tempnestedschemaset["$$"] = {"type": "CarBin"};
				
				nestedschemaset[nestedindex.toString()] = {'columns': tempnestedschemaset};
				nestedindex += 1
			} else {
				// not object ==> $$
			}
			 
		}
	}
	columns["$$"] = {"type": "CarBin"};
	return columns;
  };


  var convertResults = function(interimResults, documentsCount) {
    var getKeys = function(obj) {
      var keys = {};
      for(var key in obj) {
        keys[key] = obj[key];
      }
      return keys;
    //return keys.sort();
    };
    var varietyResults = [];
    //now convert the interimResults into the proper format
    for(var key in interimResults) {
      var entry = interimResults[key];
      varietyResults.push({
        '_id': {'key':key},
        'value': {'types':getKeys(entry.types)},
        'totalOccurrences': entry.totalOccurrences,
        'percentContaining': entry.totalOccurrences * 100 / documentsCount
      });
    }
    return varietyResults;
  };

  // Merge the keys and types of current object into accumulator object
  var reduceDocuments = function(accumulator, object) {
    var docResult = analyseDocument(serializeDoc(object, config.maxDepth, config.excludeSubkeys));
    mergeDocument(docResult, accumulator);
    return accumulator;
  };

  var reduceDocumentsterark = function(accumulatorterark, object) {
  var docResultterark = analyseDocumentterark(serializeDocterark(object, config.maxDepth), config.maxDepth);
  mergeDocumentterark(docResultterark, accumulatorterark);
  return accumulatorterark;
};


  // We throw away keys which end in an array index, since they are not useful
  // for our analysis. (We still keep the key of their parent array, though.) -JC
  var arrayRegex = new RegExp('\\.' + config.arrayEscape + '$', 'g');
  var filter = function(item) {
    return !item._id.key.match(arrayRegex);
  };

// sort desc by totalOccurrences or by key asc if occurrences equal
  var comparator = function(a, b) {
    var countsDiff = b.totalOccurrences - a.totalOccurrences;
    return countsDiff !== 0 ? countsDiff : a._id.key.localeCompare(b._id.key);
  };

  // extend standard MongoDB cursor of reduce method - call forEach and combine the results
  DBQuery.prototype.reduce = function(callback, initialValue) {
    var result = initialValue;
    this.forEach(function(obj){
      result = callback(result, obj);
    });
    return result;
  };

  var cursor = db[config.collection].find(config.query).sort(config.sort).limit(config.limit);
  var cursorterark = db[config.collection].find(config.query).sort(config.sort).limit(config.limit);
 
  var interimResults = cursor.reduce(reduceDocuments, {});
  var interimResultsterark = cursorterark.reduce(reduceDocumentsterark, {});
  
//  var varietyResults = convertResults(interimResults, cursor.size())
//  .filter(filter)
//  .sort(comparator);
  var nestedschemaset = {};
  var columns = convertSchema(interimResultsterark, cursorterark.size(), nestedschemaset, interimResults);

  // this is the part of TableIndex
  // ========================================================================
  var originalindex = db[config.collection].getIndexes();
  var generateIndex = function(originalindex) {
	  var results = [];
	  for(var index in originalindex) {
		  if ("_id_" !== originalindex[index].name) {
			  var field = Object.keys(originalindex[index].key);
			  var part = [];
			  var choice = {
				  "1" : "",
				  "-1": "-",
			  }			
			  // 1 is up, and -1 is down
			  var ordered = true;
			  var unique = originalindex[index].unique;
			  if (unique !== true)
				  unique = false;
			  for (var key in field) {
				  var upordown = originalindex[index].key[field[key]];
				  if (upordown === "hashed") {
					  part.push(field[key]);
					  ordered = false;
				  } else {
					  part.push(choice[upordown] + field[key]);
				  }
			  }
			  results.push({
					  'fields':part.toString(),
					  'ordered':ordered,
					  'unique':unique,
					  });
		  } else {
			  results.push({
					  'fields':"_id",
					  'ordered':true,
					  'unique':true,
					  });

		  }
	  }
	  return results;
  }

  var tableindex = generateIndex(originalindex);
  //print("tableindex " + tojson(tableindex));
  // ========================================================================


  // this is the result: RowSchema + TableIndex + NestedSchemaSet 
  // ========================================================================
  var Results = {};
  Results["CheckMongoType"] = true;

  Results["RowSchema"] = columns;
  if (Object.keys(tableindex).length) {
	Results["TableIndex"] = tableindex;
  }

  if (Object.keys(nestedschemaset).length) {
	Results["NestedSchemaSet"] = nestedschemaset;
  }

  print(tojson(Results));

/*
  if(config.persistResults) {
    var resultsDB;
    var resultsCollectionName = config.resultsCollection;

    if (config.resultsDatabase.indexOf('/') === -1) {
    // Local database; don't reconnect
      resultsDB = db.getMongo().getDB(config.resultsDatabase);
    } else {
    // Remote database, establish new connection
      resultsDB = connect(config.resultsDatabase);
    }

    if (config.resultsUser !== null && config.resultsPass !== null) {
      resultsDB.auth(config.resultsUser, config.resultsPass);
    }

    // replace results collection
    // log('replacing results collection: '+ resultsCollectionName);
    resultsDB[resultsCollectionName].drop();
    resultsDB[resultsCollectionName].insert(varietyResults);
  }

  var createAsciiTable = function(results) {
    var headers = ['key', 'types', 'occurrences', 'percents'];
    // return the number of decimal places or 1, if the number is int (1.23=>2, 100=>1, 0.1415=>4)
    var significantDigits = function(value) {
      var res = value.toString().match(/^[0-9]+\.([0-9]+)$/);
      return res !== null ? res[1].length : 1;
    };

    var maxDigits = varietyResults.map(function(value){return significantDigits(value.percentContaining);}).reduce(function(acc,val){return acc>val?acc:val;});

    var rows = results.map(function(row) {
      var types = [];
      var typeKeys = Object.keys(row.value.types);
      if (typeKeys.length > 1) {
        for (var type in row.value.types) {
          var typestring = type + ' (' + row.value.types[type] + ')';
          types.push(typestring);
        }
      } else {
        types = typeKeys;
      }

      return [row._id.key, types, row.totalOccurrences, row.percentContaining.toFixed(Math.min(maxDigits, 20))];
    });
    var table = [headers, headers.map(function(){return '';})].concat(rows);
    var colMaxWidth = function(arr, index) {return Math.max.apply(null, arr.map(function(row){return row[index].toString().length;}));};
    var pad = function(width, string, symbol) { return width <= string.length ? string : pad(width, isNaN(string) ? string + symbol : symbol + string, symbol); };
    table = table.map(function(row, ri){
      return '| ' + row.map(function(cell, i) {return pad(colMaxWidth(table, i), cell.toString(), ri === 1 ? '-' : ' ');}).join(' | ') + ' |';
    });
    var border = '+' + pad(table[0].length - 2, '', '-') + '+';
    return [border].concat(table).concat(border).join('\n');
  };
  var pluginsOutput = $plugins.execute('formatResults', varietyResults);
  if (pluginsOutput.length > 0) {
    pluginsOutput.forEach(function(i){print(i);});
  } else if(config.outputFormat === 'json') {
    printjson(varietyResults); // valid formatted json output, compressed variant is printjsononeline()
  } else {
    print(createAsciiTable(varietyResults)); // output nice ascii table with results
  }
*/
}.bind(this)()); // end strict mode
