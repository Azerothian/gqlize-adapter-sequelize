import Sequelize, {Op} from "sequelize";
import logger from "./utils/logger";
import unique from "./utils/unique";
import typeMapper from "./type-mapper";
import {replaceDefWhereOperators} from "./utils/replace-id-deep";
const log = logger("gqlize::adapter::sequelize::");

import jsonType from "@vostro/graphql-types/lib/json";
import { replaceWhereOperators } from "graphql-sequelize/lib/replaceWhereOperators";

// function formatObject(input) {
//   return Object.keys(input).reduce((o, y) => {
//     const str = JSON.stringify(input[y], function(k, v) { return k ? "" + v : v; }, 2);
//     return `${o}\n[${y}]: ${str}`;
//   }, "");
// }
function safeStringify(value) {
  const seen = new Set();
  return JSON.stringify(value, (k, v) => {
    if (seen.has(v) || k === "sequelize") {
      return "...";
    }
    if (typeof v === "object") {
      seen.add(v);
    }
    return v;
  }, 2);
}

export default class SequelizeAdapter {
  static name = "sequelize";
  constructor(adapterOptions = {}, ...config) {
    //allows the adaptor to have the same config options as sequelize
    this.sequelize = new (Function.prototype.bind.apply(Sequelize, [undefined].concat(config))); //eslint-disable-line
    this.options = adapterOptions;
  }
  initialise = async() => {
    return this.sequelize.sync();
  }
  reset = async() => {
    return this.sequelize.sync({force: true});
  }
  getORM = () => {
    return this.sequelize;
  }
  addInstanceFunction = (modelName, funcName, func) => {
    this.sequelize.models[modelName].prototype[funcName] = func;
  }

  addStaticFunction = (modelName, funcName, func) => {
    this.sequelize.models[modelName][funcName] = func;
  }
  getModel = (modelName) => {
    return this.sequelize.models[modelName];
  }
  getModels = () => {
    return this.sequelize.models;
  }
  getTypeMapper() {
    return typeMapper;
  }
  // getAccessors() {
  //   return {
  //     "findAll": "findAll",
  //     "findOne": "findOne",
  //     "create": "create",
  //     "update": "update"
  //   }
  // }
  getFields = (modelName) => {
    const Model = this.sequelize.models[modelName];
    //TODO add filter for excluding or including fields
    const fieldNames = Object.keys(Model.rawAttributes);
    return fieldNames.reduce((fields, key) => {
      const attr = Model.rawAttributes[key];
      const autoPopulated = attr.autoIncrement === true ||
        attr.defaultValue !== undefined ||
        !(!Model._dataTypeChanges[key]); //eslint-disable-line
      const allowNull = attr.allowNull === true;
      const foreignKey = !(!attr.references);
      let foreignTarget;
      if (foreignKey) {
        foreignTarget = Object.keys(Model.associations)
          .filter((assocKey) => {
            return Model.associations[assocKey].identifierField === key;
          }).map((assocKey) => {
            return Model.associations[assocKey].target.name;
          })[0];
        if (!foreignTarget) {
          //TODO: better error logging
          let message = `An error has occurred with relationships on model - ${modelName} - ${key}`;
          if (process.env.NODE_ENV !== "production") {
            const jsonAssociations = safeStringify(Model.associations);
            const jsonRelationships = safeStringify(Model.relationships);
            message = `Model: ${modelName} - Unable to find ${key} identifier field association in the model associations \n ---Associations--- ${jsonAssociations}\n ---Relationships--- ${jsonRelationships}`;
          }
          throw new Error(message);
        }
      }

      fields[key] = {
        name: key,
        type: attr.type,
        primaryKey: attr.primaryKey === true,
        allowNull,
        description: attr.comment,
        defaultValue: attr.defaultValue,
        foreignKey,
        foreignTarget,
        autoPopulated,
      };
      return fields;
    }, {});
  }
  getRelationships = (modelName) => {
    const Model = this.sequelize.models[modelName];
    return Object.keys(Model.associations)
      .reduce((fields, key) => {
        const assoc = Model.associations[key];
        const {associationType} = assoc;
        fields[key] = {
          name: key,
          target: assoc.target.name,
          source: assoc.source.name,
          associationType: `${associationType.charAt(0).toLowerCase()}${associationType.slice(1)}`,
          foreignKey: assoc.foreignKey,
          targetKey: assoc.targetKey,
          sourceKey: assoc.sourceKey,
          accessors: assoc.accessors,
        };
        return fields;
      }, {});
  }
  createModel = async(def, hooks) => {
    const {defaultAttr, defaultModel} = this.options;
    const newDef = Object.assign({}, def, {
      options: Object.assign({}, def.options, {
        hooks,
      }),
    });
    let schemaOptions = Object.assign({}, defaultModel, def.options);
    // const hooks = [this.options.hooks || {}, schemaOptions.hooks || {}];
    // schemaOptions = Object.assign(schemaOptions, {
    //   hooks: generateHooks(hooks, def.name),
    // });
    this.sequelize.define(newDef.name, Object.assign({}, defaultAttr, newDef.define), schemaOptions);

    let {classMethods, instanceMethods} = newDef;
    if (newDef.options) {
      if (newDef.options.classMethods) {
        classMethods = newDef.options.classMethods;
      }
      if (newDef.options.instanceMethods) {
        instanceMethods = newDef.options.instanceMethods;
      }
    }
    if (classMethods) {
      Object.keys(classMethods).forEach((classMethod) => {
        this.sequelize.models[newDef.name][classMethod] = classMethods[classMethod];
      });
    }
    if (instanceMethods) {
      Object.keys(instanceMethods).forEach((instanceMethod) => {
        this.sequelize.models[newDef.name].prototype[instanceMethod] = instanceMethods[instanceMethod];
      });
    }
    return this.sequelize.models[newDef.name];
  }
  createRelationship = (targetModel, sourceModel, name, type, options = {}) => {
    let model = this.sequelize.models[targetModel];
    if (!model.relationships) {
      model.relationships = {};
    }
    try {
      if (options.through) {
        if (options.through.model) {
          options.through.model = this.sequelize.models[options.through.model];
        }
      }
      const opts = Object.assign({
        as: name,
      }, options);
      model.relationships[name] = {
        type: type,
        source: sourceModel,
        target: targetModel,
        options: opts,
        rel: model[type](this.sequelize.models[sourceModel], opts),
      };
    } catch (err) {
      log.error("Error Mapping relationship", {model, sourceModel, name, type, options, err});
    }
    this.sequelize.models[targetModel] = model;
  }
  createFunctionForFind = (modelName) => {
    const model = this.sequelize.models[modelName];
    return function(value, filterKey, singular) {
      return (options = {}) => {
        const opts = Object.assign({}, options, {
          where: mergeFilterStatement(filterKey, value, true, options.where),
        });
        if (!singular) {
          return model.findAll(opts);
        }
        return model.findOne(opts);
      };
    };
  }
  getPrimaryKeyNameForModel = (modelName) => {
    return this.sequelize.models[modelName].primaryKeyAttribute;
  }
  getValueFromInstance(data, keyName) {
    return data.get(keyName);
  }
  getFilterGraphQLType() {
    return jsonType;
  }
  getDefaultListArgs() {
    return {
      where: {
        type: jsonType,
      },
    };
  }
  hasInlineCountFeature = () => {
    if (this.options.disableInlineCount) {
      return false;
    }
    const dialect = this.sequelize.dialect.name;
    return (dialect === "postgres" || dialect === "mssql" || dialect === "sqlite");
  }
  getInlineCount = (values) => {
    let fullCount = values[0] &&
      (values[0].dataValues || values[0]).full_count &&
      parseInt((values[0].dataValues || values[0]).full_count, 10);
    if (!values[0]) {
      fullCount = 0;
    }
    return fullCount;
  }
  processListArgsToOptions = async(defName, args, info, whereOperators, defaultOptions = {}, selectedFields) => {
    let limit, order, attributes = defaultOptions.attributes || [], where;
    // const Model = this.getModel(defName);
    if (args.first || args.last) {
      limit = parseInt(args.first || args.last, 10);
    }
    if (args.orderBy) {
      order = args.orderBy;
    }
    if (this.hasInlineCountFeature()) {
      const fields = this.getFields(defName);
      Object.keys(fields).forEach((key) => {
        const field = fields[key];
        if (!field.primaryKey) {
          if (selectedFields) {
            if (selectedFields.indexOf(key) === -1) {
              return;
            }
          }
          attributes.unshift(field.name);
        }
      });
      // const fieldAttr

      attributes.unshift(this.getPrimaryKeyNameForModel(defName));

      // attributes.push(...this.getFields(defName).filter((f) => !f.primaryKey).map((f) => f.name))
      if (attributes.filter((a) => a.indexOf("full_count") > -1).length === 0) {
        if (this.sequelize.dialect.name === "postgres") {
          attributes.push([
            this.sequelize.literal("COUNT(*) OVER()"),
            "full_count",
          ]);
        } else if (this.sequelize.dialect.name === "mssql" || this.sequelize.dialect.name === "sqlite") {
          attributes.push([
            this.sequelize.literal("COUNT(1) OVER()"),
            "full_count",
          ]);
        } else {
          throw new Error(`Inline count feature enabled but dialect does not match`);
        }
      }
    }
    if (args.where) {
      where = await this.processFilterArgument(args.where, whereOperators);
    }
    return {
      getOptions: Object.assign({
        order,
        where,
        limit,
        attributes: unique(attributes),
      }, defaultOptions),
      countOptions: !(this.hasInlineCountFeature()) ? Object.assign({
        where,
        attributes,
      }, defaultOptions) : undefined,
    };
  }
  async processFilterArgument(where, whereOperators) {
    const w = replaceWhereOperators(where);
    if (whereOperators) {
      return replaceDefWhereOperators(w, whereOperators, {});
    }
    return w;
  }
  getAllArgsToReplaceId() {
    return ["where"];
  }
  findAll = (defName, options) => {
    const Model = this.sequelize.models[defName];
    return Model.findAll(options);
  }
  count = (defName, options) => {
    const Model = this.sequelize.models[defName];
    return Model.count(options);
  }
  update = (source, input, options) => {
    return source.update(input, options);
  }
  getCreateFunction = (defName) => {
    const Model = this.sequelize.models[defName];
    return (input, options) => {
      return Model.create(input, options);
    };
  }
  getUpdateFunction = (defName, whereOperators) => {
    const Model = this.sequelize.models[defName];
    return async(where, processInput, options) => {
      const items = await Model.findAll({
        where: await this.processFilterArgument(where, whereOperators),
        ...options,
      });
      return Promise.all(items.map(async(i) => {
        const input = await processInput(i);
        if (Object.keys(input).length > 0) {
          return i.update(input, options);
        }
        return i;
      }));
    };
  }
  getDeleteFunction = (defName, whereOperators) => {
    const Model = this.sequelize.models[defName];
    return async(where, options, before, after) => {
      const items = Model.findAll({
        where: await this.processFilterArgument(where, whereOperators),
        ...options,
      });
      return items.map(async(i) => {
        i = await before(i);
        await i.destroy(options);
        i = await after(i);
        return i;
      });
    };
  }
  mergeFilterStatement(fieldName, value, match, originalWhere) {
    return mergeFilterStatement(fieldName, value, match, originalWhere);
  }
}


// function generateHooks(hooks = [], schemaName) {
//   return hooks.reduce((o, h) => {
//     Object.keys(h).forEach((hookName) => {
//       if (!o[hookName]) {
//         o[hookName] = createHookQueue(hookName, hooks, schemaName);
//       }
//     });
//     return o;
//   }, {});
// }

// function createHookQueue(hookName, hooks, schemaName) {
//   return function(init, options, error) {
//     return hooks.reduce((promise, targetHooks) => {
//       return promise.then(async(val) => {
//         if (targetHooks[hookName]) {
//           let result;
//           if (Array.isArray(targetHooks[hookName])) {
//             result = await waterfall(targetHooks[hookName], (hook, prevResult) => {
//               return hook(prevResult, options, error, schemaName, hookName);
//             }, val);
//           } else {
//             result = await targetHooks[hookName](val, options, error, schemaName, hookName);
//           }
//           if (result) {
//             return result;
//           }
//         }
//         return val;
//       });
//     }, Promise.resolve(init));
//   };
// }



export function mergeFilterStatement(fieldName, value, match = true, originalWhere) {
  let targetOp = Op.eq;
  if (Array.isArray(value)) {
    targetOp = (match) ? Op.in : Op.notIn;
  } else {
    targetOp = (match) ? Op.eq : Op.ne;
  }
  const filter = {
    [fieldName]: {
      [targetOp]: value,
    },
  };
  if (originalWhere) {
    return {
      [Op.and]: [originalWhere, filter],
    };
  }
  return filter;
}
