import autoBind from 'auto-bind';
import _ from 'lodash';
import Validator from 'validator';

import BaseModel, {XcFilter, XcFilterWithAlias} from '../BaseModel';
import formulaQueryBuilder from "./formulaQueryBuilderFromString";
import genRollupSelect from "./genRollupSelect";


/**
 * Base class for models
 *
 * @class
 * @classdesc Base class for models
 */
class BaseModelSql extends BaseModel {

  private dbModels: {
    [tn: string]: BaseModelSql
  };

  public readonly _tn: string;
  private _selectFormulas: any;
  private _selectFormulasObj: any;
  private _defaultNestedQueryParams: any;

  /**
   *
   * @param {Object} args
   * @param {Object} args.knex - Knex instance
   * @param {String} args.tn - table name
   * @param {Object[]} args.columns - columns
   * @param {Object[]} args.pks - primary keys
   * @param {Object[]} args.hasMany - has many relations
   * @param {Object[]} args.belongsTo - belongs to relations
   * @param {Object} args.hooks - afterInsert, beforeInsert, errorInsert, afterUpdate, beforeUpdate, errorUpdate, afterDelete, beforeDelete, errorDelete
   * @returns {BaseModelSql} Returns {@link BaseModelSql} reference.
   *
   */
  constructor(
    {
      dbDriver,
      tn,
      _tn,
      columns,
      hasMany = [],
      belongsTo = [],
      manyToMany = [],
      v,
      type,
      dbModels
    }: {
      [key: string]: any,
      dbModels?: {
        [tn: string]: BaseModelSql
      }
    }) {

    super({
      dbDriver,
      tn,
      columns,
      hasMany,
      belongsTo,
      type
    })

    this.dbDriver = dbDriver;
    this.columns = columns;

    this.pks = columns.filter(c => c.pk === true);
    this.hasManyRelations = hasMany;
    this.belongsToRelations = belongsTo;
    this.manyToManyRelations = manyToMany;
    this.virtualColumns = v;
    this.config = {
      limitDefault: process.env.DB_QUERY_LIMIT_DEFAULT || 10,
      limitMax: process.env.DB_QUERY_LIMIT_MAX || 500,
      limitMin: process.env.DB_QUERY_LIMIT_MIN || 1,
      log: false,
      explain: false,
      hasManyMax: 5,
      bulkLengthMax: 1000,
      chunkSize: 50,
      stepMin: 1,
      stepsMax: 100,
      record: true,
      timeout: 25000
    };

    this.clientType = this.dbDriver.clientType();
    this.dbModels = dbModels;
    this._tn = _tn;
    autoBind(this)
  }


  /**
   * Validates column values against validation functions
   *
   * @param {Object[]} columns - columns with values
   * @memberof BaseModel
   * @returns Promise<Boolean>
   * @throws {Error}
   */
  async validate(columns) {
    // let cols = Object.keys(this.columns);
    for (let i = 0; i < this.columns.length; ++i) {
      const {validate: {func, msg}, cn} = this.columns[i];
      for (let j = 0; j < func.length; ++j) {
        const fn = typeof func[j] === 'string' ? Validator[func[j]] : func[j];
        const arg = typeof func[j] === 'string' ? columns[cn] + "" : columns[cn];
        if (columns[cn] !== null && columns[cn] !== undefined && columns[cn] !== '' && cn in columns && !(fn.constructor.name === "AsyncFunction" ? await fn(arg) : fn(arg))) {
          throw new Error(msg[j].replace(/\{VALUE}/g, columns[cn])
            .replace(/\{cn}/g, cn))
        }
      }
    }
    return true;
  }

  /**
   *
   * @returns {Object} knex instance attached to a table
   */
  public get $db() {
    return this.dbDriver(this.tnPath);
  }

  public get tnPath() {
    const schema = (this.dbDriver as any).searchPath?.();
    const table = this.isMssql() && schema ? this.dbDriver.raw('??.??', [schema, this.tn]) : this.tn;
    return table;
  }

  /**
   * _wherePk
   *
   * @param {String} id - pk separated by ___
   * @returns {Object} - primary key where condition
   * @private
   */
  _wherePk(id) {
    const ids = (id + '').split('___');
    const where = {};
    for (let i = 0; i < this.pks.length; ++i) {
      where[this.pks[i].cn] = ids[i];
    }
    return where;
  }

  /**
   * _whereFk
   *
   * @param {Object} args
   * @param {String} args.tnp - parent table name
   * @param {String} args.parentId - foreign key
   * @returns {Object} - foreign key where condition
   * @private
   */
  _whereFk({tnp, parentId}) {
    const {cn} = this.belongsToRelations.find(({rtn}) => rtn === tnp)
    const where = {[cn]: parentId};
    return where;
  }

  /**
   *
   * @param obj
   * @returns {Object} Copy of the object excluding primary keys
   * @private
   */
  _extractPks(obj): {
    [key: string]: any
  } {
    const objCopy = this.mapAliasToColumn(obj);
    for (const key in objCopy) {
      if (this.pks.filter(pk => pk._cn === key).length === 0) {
        delete objCopy[key];
      }
    }
    return objCopy;
  }

  /**
   *
   * @param obj
   * @returns {Object} Copy of the object excluding primary keys
   * @private
   */
  _extractPksValues(obj): string {
    const objCopy = this.mapAliasToColumn(obj);
    for (const key in objCopy) {
      if (this.pks.filter(pk => pk._cn === key).length === 0) {
        delete objCopy[key];
      }
    }
    return Object.values(objCopy).join('___');
  }


  /**
   * Returns a transaction reference
   *
   * @async
   *
   * @returns {Promise<Object>} Transaction reference
   */
  async transaction() {
    return await this.dbDriver.transaction();
  }

  /**
   * Commit transaction
   *
   * @async
   * @param {Object} trx - Transaction reference
   * @returns {Promise<void>}
   */
  async commit(trx) {
    await trx.commit();
  }


  /**
   * Rollback transaction
   *
   * @async
   * @param {Object} trx - Transaction reference
   * @returns {Promise<void>}
   */
  async rollback(trx) {
    await trx.rollback();
  }


  /**
   * Transaction completed
   *
   * @async
   * @param {Object} trx - Transaction reference
   * @returns {Promise<void>}
   */
  isCompleted(trx) {
    return trx.isCompleted();
  }


  /**
   * Creates row in table
   *
   * @param {Object} data - row data
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Object[]>|Promise<Number[]>}
   */
  // todo: optimize
  async insert(data, trx = null, cookie?: any) {

    try {

      const insertObj = this.mapAliasToColumn(data);

      if ('beforeInsert' in this) {
        await this.beforeInsert(insertObj, trx, cookie)
      }

      let response;
      const driver = trx ? trx : this.dbDriver;

      await this.validate(insertObj);

      const query = driver(this.tnPath).insert(insertObj);

      if (this.isPg() || this.dbDriver.clientType() === 'mssql') {
        query.returning(Object.entries(this.aliasToColumn).map(([val, key]) => `${key} as ${val}`));
        response = await this._run(query);
      }

      const ai = this.columns.find(c => c.ai);
      if (!response || (typeof response?.[0] !== 'object' && response?.[0] !== null)) {
        let id;
        if (response?.length) {
          id = response[0];
        } else {
          id = (await this._run(query))[0];
        }

        if (ai) {
          // response = await this.readByPk(id)
          response = await this.nestedRead(id, this.defaultNestedBtQueryParams)
        } else {
          response = data;
        }
      } else if (ai) {
        response = await this.nestedRead(Array.isArray(response) ? response?.[0]?.[ai._cn] : response?.[ai._cn], this.defaultNestedBtQueryParams)
      }

      if (Array.isArray(response)) {
        response = response[0];
      }

      await this.afterInsert(response, trx, cookie);
      return Array.isArray(response) ? response[0] : response;
    } catch (e) {
      console.log(e);
      await this.errorInsert(e, data, trx, cookie)
      throw e;
    }
  }


  private isPg() {
    return this.dbDriver.clientType() === 'pg';
  }

  /**
   * Update table row data by primary key
   *
   * @param {String} id - primary key separated by ___
   * @param {Object} data - table row data
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Number>} 1 for success, 0 for failure
   */
  async updateByPk(id, data, trx = null, cookie?: any) {
    try {
      const mappedData = this.mapAliasToColumn(data);

      await this.validate(data);

      await this.beforeUpdate(data, trx, cookie);

      const driver = trx ? trx : this.dbDriver

      // this.validate(data);
      await this._run(driver(this.tnPath).update(mappedData).where(this._wherePk(id)));

      const response = await this.nestedRead(id, this.defaultNestedQueryParams)
      await this.afterUpdate(response, trx, cookie);
      return response;
    } catch (e) {
      console.log(e);
      await this.errorUpdate(e, data, trx, cookie);
      throw e;
    }
  }


  /**
   * Delete table row data by primary key
   *
   * @param {String} id - primary key separated by ___
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Number>} 1 for success, 0 for failure
   */
  async delByPk(id, trx = null, cookie?: any) {
    try {
      await this.beforeDelete({id}, trx, cookie);

      const dbDriver = trx ? trx : this.dbDriver;

      const response = await this._run(dbDriver(this.tnPath).del().where(this._wherePk(id)));
      await this.afterDelete({id}, trx, cookie);
      return response;
    } catch (e) {
      console.log(e);
      await this.errorDelete(e, {id}, trx, cookie);
      throw e;
    }
  }

  /**
   * Creates row in this table under a certain parent
   *
   * @param {Object} args
   * @param {Object} args.data - row data
   * @param {String} args.parentId - parent table id
   * @param {String} args.tnp - parent table name
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Object[]>|Promise<Object[]>}
   * @todo should return inserted record
   */
  async insertByFk({parentId, tnp, data}, trx = null, cookie?: any) {

    try {
      const insertObj = this.mapAliasToColumn(data);

      await this.beforeInsert(insertObj, trx, cookie);

      let response;
      const dbDriver = trx ? trx : this.dbDriver;
      await this.validate(insertObj);
      Object.assign(insertObj, this._whereFk({parentId, tnp}))

      const query = dbDriver(this.tnPath).insert(insertObj);

      if (this.dbDriver.clientType() === 'pg' || this.dbDriver.clientType() === 'mssql') {
        query.returning(this.selectQuery(''));
        response = await this._run(query);
      }
      // else {
      //   response = insertObj;
      //   const res = await this._run(query);
      //   const ai = this.columns.find(c => c.ai);
      //   if (ai) {
      //     response[ai._cn] = res[0];
      //   }
      // }
      if (!response || (typeof response?.[0] !== 'object' && response?.[0] !== null)) {
        let id;
        if (response?.length) {
          id = response[0];
        } else {
          id = (await this._run(query))[0];
        }

        const ai = this.columns.find(c => c.ai);
        if (ai) {
          response = await this.readByPk(id)
        } else {
          response = data;
        }
      }


      await this.afterInsert(data, trx, cookie)
      return response;
    } catch (e) {
      console.log(e);
      await this.errorInsert(e, data, trx, cookie)
      throw e;
    }
  }

  /**
   * Update table row data by primary key and foreign key
   *
   * @param {Object} args
   * @param {String} args.id - primary key separated by ___
   * @param {String} args.parentId - parent table id
   * @param {String} args.tnp - parent table name
   * @param {Object} args.data - table row data
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Number>} 1 for success, 0 for failure
   */
  async updateByFk({id, parentId, tnp, data}, trx = null, cookie = {}) {
    try {
      data = this.mapAliasToColumn(data);

      await this.validate(data);
      await this.beforeUpdate(data, trx, cookie);

      const dbDriver = trx ? trx : this.dbDriver;
      // this.validate(data);
      const response = await this._run(dbDriver(this.tnPath).update(data).where(this._wherePk(id)).andWhere(this._whereFk({
        tnp,
        parentId
      })));
      await this.afterUpdate(response, trx, cookie);
      return response;
    } catch (e) {
      console.log(e);
      await this.errorUpdate(e, data, trx, cookie);
      throw e;
    }
  }


  /**
   * Update table row data by using  where clause
   *
   * @param {Object} args
   * @param {String} args.where - update where clause
   * @param {Object} args.data - table row data
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Number>} number of rows affected
   */
  async update({data, where, condition}, trx) {
    try {
      this.mapAliasToColumn(data);
      // await this.beforeUpdate(data);
      await this.validate(data);

      const driver = trx ? trx : this.dbDriver

      const response = await this._run(driver(this.tnPath).update(data).xwhere(where, this.selectQuery('')).condition(condition, this.selectQuery('')));

      // await this.afterUpdate(data);
      return response;
    } catch (e) {
      console.log(e);
      // await this.errorUpdate(e, data);
      throw e;
    }

  }


  /**
   * Delete table row data by primary key and foreign key
   *
   * @param {Object} args
   * @param {String} args.id - primary key separated by ___
   * @param {String} args.parentId - parent table id
   * @param {String} args.tnp - parent table name
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Number>} 1 for success, 0 for failure
   */
  async delByFk({id, parentId, tnp}, trx = null, cookie?: any) {
    try {
      await this.beforeDelete({id, parentId, tnp}, trx, cookie);

      const dbDriver = trx ? trx : this.dbDriver;
      const response = await this._run(dbDriver(this.tnPath).del().where(this._wherePk(id)).andWhere(this._whereFk({
        tnp,
        parentId
      })));
      await this.afterDelete({id, parentId, tnp}, trx, cookie);
      return response;
    } catch (e) {
      console.log(e);
      await this.errorDelete(e, {id, parentId, tnp}, trx, cookie);
      throw e;
    }
  }


  /**
   * Delete table row data by where conditions
   *
   * @param {Object} args
   * @param {String} args.where - where clause for deleting
   * @param {Object} [trx] - knex transaction object
   * @returns {Promise<Number>} number of deleted records
   */
  async del({where, condition}, trx) {
    try {
      // await this.beforeUpdate(data);

      const driver = trx ? trx : this.dbDriver

      const response = await this._run(driver(this.tnPath).del().xwhere(where, this.selectQuery('')).condition(condition, this.selectQuery('')));

      // await this.afterUpdate(data);
      return response;
    } catch (e) {
      console.log(e);
      // await this.errorUpdate(e, data);
      throw e;
    }

  }


  /**
   * Creates multiple rows in table
   *
   * @param {Object[]} data - row data
   * @returns {Promise<Object[]>|Promise<Number[]>}
   */
  async insertb(data) {

    try {

      const insertDatas = data.map(d => this.mapAliasToColumn(d));

      await this.beforeInsertb(insertDatas, null)

      for (const d1 of insertDatas) {
        await this.validate(d1);
      }

      const response = await this.dbDriver.batchInsert(this.tn, insertDatas, 50)
        .returning(this.pks[0].cn);

      await this.afterInsertb(insertDatas, null);

      return response;

    } catch (e) {
      await this.errorInsertb(e, data, null);
      throw e;
    }
  }


  /**
   * Update bulk - happens within a transaction
   *
   * @param {Object[]} data - table rows to be updated
   * @returns {Promise<Number[]>} - 1 for success, 0 for failure
   */
  async updateb(data) {

    let transaction;
    try {

      const insertDatas = data.map(d => this.mapAliasToColumn(d));


      transaction = await this.dbDriver.transaction();

      await this.beforeUpdateb(insertDatas, transaction);
      const res = [];
      for (const d of insertDatas) {

        await this.validate(d);
        // this.validate(d);
        const response = await this._run(transaction(this.tn).update(d).where(this._extractPks(d)));
        res.push(response);
      }

      await this.afterUpdateb(res, transaction);
      transaction.commit();

      return res;

    } catch (e) {
      if (transaction)
        transaction.rollback();
      console.log(e);
      await this.errorUpdateb(e, data, null);
      throw e;
    }
  }


  /**
   * Bulk delete happens within a transaction
   *
   * @param {Object[]} ids - rows to be deleted
   * @returns {Promise<Number[]>} - 1 for success, 0 for failure
   */
  async delb(ids) {
    let transaction;
    try {
      transaction = await this.dbDriver.transaction();
      await this.beforeDeleteb(ids, transaction);

      const res = [];
      for (const d of ids) {
        const response = await this._run(transaction(this.tn).del().where(this._extractPks(d)));
        res.push(response);
      }
      await this.afterDeleteb(res, transaction);

      transaction.commit();

      return res;

    } catch (e) {
      if (transaction)
        transaction.rollback();
      console.log(e);
      await this.errorDeleteb(e, ids);
      throw e;
    }

  }


  /**
   * Reads table row data
   *
   * @param {String} id - primary key separated by ___
   * @returns {Promise<Object>} Table row data
   */
  async readByPk(id, args?: { conditionGraph?: any }) {
    try {
      return await this._run(
        this.$db.select(this.selectQuery('*'))
          .select(...this.selectFormulas)
          .conditionGraph(args?.conditionGraph)
          .where(this._wherePk(id)).first()
      ) || {};
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Reads table row data under a certain parent
   *
   * @param {Object} args
   * @param {Object} args.id - primary key separated by ___
   * @param {String} args.parentId - parent table id
   * @param {String} args.tnp - parent table name
   * @returns {Promise<Object>} returns row
   */
  async readByFk({id, parentId, tnp, conditionGraph = null}) {
    try {

      return await this._run(this.$db.select(
        `${this.tn}.*`
      )
        .conditionGraph(conditionGraph)
        .where(this._wherePk(id)).andWhere(this._whereFk({
          tnp,
          parentId
        })).limit(1));
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Get the list of rows in table
   *
   * @param {object} args
   * @param {String} [args.fields=*] - commas separated column names of this table
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object[]>} rows
   * @memberof BaseModel
   * @throws {Error}
   */
  async list(args = {}) {

    try {

      const {fields, where, limit, offset, sort, condition, conditionGraph = null, having} = this._getListArgs(args);

      const query = this.$db
        // .select(...fields.split(','))
        .select(this.selectQuery(fields))
        .select(...this.selectFormulas)
        .select(...this.selectRollups)
        .xwhere(where, {...this.selectQuery(''), ...this.selectFormulasObj})
        .xhaving(having, this.selectQuery(''))
        .condition(condition, this.selectQuery(''))
        .conditionGraph(conditionGraph);

      this._paginateAndSort(query, {limit, offset, sort});

      return await this._run(query);

    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Get the first row from the select query
   *
   * @param {object} args
   * @param {String} [args.fields=*] - commas separated column names of this table
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object>} row
   * @memberof BaseModel
   * @throws {Error}
   */
  async findOne(args: XcFilterWithAlias = {}) {
    try {
      const {where, condition, conditionGraph, ...rest} = this._getListArgs(args);
      let {fields} = rest;
      if (fields === '*') {
        fields = `${this.tn}.*`;
      }
      const query = this.$db
        // .select(fields)
        .select(this.selectQuery(fields))
        .xwhere(where, this.selectQuery('')).condition(condition, this.selectQuery(''))
        .conditionGraph(conditionGraph).first();
      this._paginateAndSort(query, args)
      return await this._run(query) || {};
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Get the first row from the select query
   *
   * @param {object} args
   * @param {String} [args.fields=*] - commas separated column names of this table
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @param {String} args.parentId - parent table id
   * @param {String} args.tnp - parent table name
   * @returns {Promise<Object>} row
   * @memberof BaseModel
   * @throws {Error}
   */
  async findOneByFk({parentId, tnp, ...args}) {
    try {
      const {where, condition, conditionGraph, ...restArgs} = this._getListArgs(args);
      let {fields} = restArgs;
      if (fields === '*') {
        fields = `${this.tn}.*`;
      }
      const query = this.$db
        // .select(fields)
        .select(this.selectQuery(fields))
        .where(this._whereFk({parentId, tnp}))
        .xwhere(where, this.selectQuery(''))
        .condition(condition, this.selectQuery(''))
        .conditionGraph(conditionGraph)
        .first();
      this._paginateAndSort(query, args)
      return await this._run(query);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }


  /**
   * Get the count of rows based on the where
   *
   * @param {object} args
   * @param {String} [args.where]  - where clause with conditions within ()
   * @returns {Promise<Object>}
   * @memberof BaseModel
   * @throws {Error}
   */
  async countByPk({where = '', conditionGraph = null, having = ''}) {
    try {
      if (this.isPg() && !conditionGraph && !where && !having) {
        const res = (await this._run(
          this.dbDriver.raw(`select reltuples::int8 as count 
        from pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        where nspname=? AND relname=?`, [this.config?.searchPath?.[0] || 'public', this.tn])
        ))?.rows?.[0];
        if (res?.count > 1000) {
          return res;
        }
      }

      return await this._run(this.$db
        .conditionGraph(conditionGraph)
        .count(`${this.tn}.${(this.pks[0] || this.columns[0]).cn} as count`)
        .xwhere(where, {...this.selectQuery(''), ...this.selectFormulasObj})
        .xhaving(having, this.selectQuery(''))
        .first());
    } catch (e) {
      console.log(e);
      throw e;
    }
  }


  /**
   * Get the count of rows based on the where
   *
   * @param {object} args
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} args.parentId - parent table id
   * @param {String} args.tnp - parent table name
   * @returns {Promise<Object>}
   * @memberof BaseModel
   * @throws {Error}
   */
  async countByFk({where, parentId, tnp, conditionGraph = null}) {
    try {
      return await this._run(this.$db.where(this._whereFk({
        parentId,
        tnp
      })).count(`${this.tn}.${(this.pks[0] || this.columns[0]).cn} as count`)
        .xwhere(where, this.selectQuery(''))
        .conditionGraph(conditionGraph)
        .first());
    } catch (e) {
      console.log(e);
      throw e;
    }
  }


  /**
   * Table row exists
   *
   * @param {String} id - ___ separated primary key string
   * @returns {Promise<boolean>} - true for exits and false for none
   */
  async exists(id, args?: { conditionGraph?: any }) {
    try {
      return (Object.keys(await this.readByPk(id, args)).length !== 0);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Table row exists
   *
   * @param {String} id - ___ separated primary key string
   * @returns {Promise<boolean>} - true for exits and false for none
   */
  async existsByFk({id, parentId, tnp, conditionGraph = null}) {
    try {
      return (await this.readByFk({id, parentId, tnp, conditionGraph})).length !== 0;
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Get the rows by group by
   *
   * @param {object} args
   * @param {String} args.cn - column name of this table()
   * @param {String} [args.fields] - commas separated column names of this table
   * @param {String} [args.having]  - having clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object[]>} rows
   * @memberof BaseModel
   * @throws {Error}
   */
  async groupBy({having, fields = '', column_name, limit, offset, sort}) {
    try {
      const columns = [...(column_name ? [column_name] : []), ...fields.split(',').filter(Boolean)];
      const query = this.$db
        .groupBy(columns)
        .count(`${(this.pks[0] || this.columns[0]).cn} as count`)
        // .select(columns)
        .select(this.selectQuery(columns.join(',')))
        .xhaving(having, this.selectQuery(''));

      this._paginateAndSort(query, {limit, offset, sort});

      return await this._run(query);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }


  /**
   * Get the rows by aggregation by an aggregation function(s)
   *
   * @param {object} args
   * @param {String} args.func - comma separated aggregation functions
   * @param {String} args.cn - column name of this table()
   * @param {String} [args.fields] - commas separated column names of this table
   * @param {String} [args.having]  - having clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object[]>} rows - aggregated rows by function names
   * @memberof BaseModel
   * @throws {Error}
   */
  async aggregate({having, fields = '', func, column_name, limit, offset, sort}) {
    try {
      const query = this.$db
        // .select(...fields.split(','))
        .select(this.selectQuery(fields))
        .xhaving(having, this.selectQuery(''));

      if (fields) {
        query.groupBy(...fields.split(','))
      }
      if (column_name) {
        query.groupBy(column_name)
      }
      if (func && column_name) {
        func.split(',').forEach(fn => query[fn](`${column_name} as ${fn}`))
      }


      this._paginateAndSort(query, {limit, offset, sort});

      return await this._run(query);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }


  /**
   * Distribution of column values in the table
   *
   * @param {object} args
   * @param {String} [args.func=count] - comma separated aggregation functions
   * @param {String} args.cn - column name of this table()
   * @param {String} [args.steps]  - comma separated ascending numbers
   * @param {String} [args.min] - minimum value
   * @param {String} [args.max] - maximum value
   * @param {String} [args.step] - step value
   * @returns {Promise<Object[]>} Distributions of column values in table
   * @example
   * table.distribution({
   *   cn : 'price',
   *   steps: '0,100,200,300,400',
   *   func: 'sum,avg'
   * })
   * @example
   * table.distribution({
   *   cn : 'price',
   *   min: '0',
   *   max: '400',
   *   step: '100',
   *   func: 'sum,avg'
   * })
   * @memberof BaseModel
   * @throws {Error}
   */
  async distribution({column_name, steps, func = 'count', min, max, step}) {

    try {

      column_name = this.aliasToColumn[column_name] || column_name;

      const ranges = [];

      const generateWindows = (ranges, _min, max, step) => {
        max = +max;
        step = +step;

        for (let i = 0; i < max / step; i++) {
          ranges.push([i * step + (i && 1), Math.min((i + 1) * step, max)])
        }
      };


      if (!isNaN(+min) && !isNaN(+max) && !isNaN(+step)) {
        generateWindows(ranges, min, max, step)
      } else if (steps) {
        const splitArr = steps.split(',');
        for (let i = 0; i < splitArr.length - 1; i++) {
          ranges.push([+splitArr[i] + (i ? 1 : 0), splitArr[i + 1]])
        }
      } else {
        const {min, max, step} = await this.$db
          .min(`${column_name} as min`)
          .max(`${column_name} as max`)
          .avg(`${column_name} as step`)
          .first();
        generateWindows(ranges, min, max, Math.round(step))
      }

      return (await this.dbDriver.unionAll(
        ranges.map(([start, end]) => {
            const query = this.$db.xwhere(`(${column_name},ge,${start})~and(${column_name},le,${end})`);
            if (func) {
              func.split(',').forEach(fn => query[fn](`${column_name} as ${fn}`))
            }
            return this.isSqlite() ? this.dbDriver.select().from(query) : query;
          }
        ), !this.isSqlite()
      )).map((row, i) => {
        row.range = ranges[i].join('-');
        return row;
      });
    } catch (e) {
      console.log(e);
      throw e;
    }

  }


  /**
   * Get the list of distinct rows
   *
   * @param {object} args
   * @param {String} args.cn - column name of this table()
   * @param {String} [args.fields] - commas separated column names of this table
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object[]>} rows
   * @memberof BaseModel
   * @throws {Error}
   */
  async distinct({cn, fields = '', where, limit, offset, sort, conditionGraph = null}) {
    try {
      const query = this.$db;
      query.distinct(this.selectQuery([cn, ...fields.split(',').filter(Boolean)].join(',')));
      query.xwhere(where, this.selectQuery('')).conditionGraph(conditionGraph);
      this._paginateAndSort(query, {limit, offset, sort});
      return await this._run(query);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Runs raw query on database
   *
   * @param {String} queryString - query string
   * @param {Object[]} params - paramaterised values in an array for query
   * @returns {Promise} - return raw data from database driver
   */
  async raw(queryString, params = []) {
    try {
      const query = this.dbDriver.raw(queryString, params);
      return await this._run(query);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }


  /**
   * Get child list and map to input parent
   *
   * @param {Object[]} parent - parent list array
   * @param {String} child - child table name
   * @param {Object} rest - index suffixed fields, limit, offset, where and sort
   * @param {Object} rest - index suffixed fields, limit, offset, where and sort
   * @param index - child table index
   * @returns {Promise<void>}
   * @private
   */
  async _getChildListInParent({parent, child}, rest = {}, index) {
    const {where, limit, offset, sort, ...restArgs} = this._getChildListArgs(rest, index, child, 'h');
    let {fields} = restArgs;
    const {cn} = this.hasManyRelations.find(({tn}) => tn === child) || {};
    const _cn = this.dbModels[child].columnToAlias?.[cn];

    if (fields !== '*' && fields.split(',').indexOf(cn) === -1) {
      fields += ',' + cn;
    }


    const childs = await this._run(this.dbDriver.union(
      parent.map(p => {
        const id = p[this.columnToAlias?.[this.pks[0].cn] || this.pks[0].cn] || p[this.pks[0].cn];
        const query =
          this
            .dbDriver(this.dbModels[child].tnPath)
            .where(cn, id)
            .xwhere(where, this.dbModels[child].selectQuery(''))
            .select(this.dbModels[child].selectQuery(fields)) // ...fields.split(','));

        this._paginateAndSort(query, {sort, limit, offset}, null, true);
        return this.isSqlite() ? this.dbDriver.select().from(query) : query;
      }), !this.isSqlite()
    ));

    const gs = _.groupBy(childs, _cn);
    parent.forEach(row => {
      row[`${this.dbModels?.[child]?._tn || child}List`] = gs[row[this.pks[0]._cn]] || [];
    })
  }

  /**
   * Get child list and map to input parent
   *
   * @param {Object[]} parent - parent list array
   * @param {String} child - child table name
   * @param {Object} rest - index suffixed fields, limit, offset, where and sort
   * @param index - child table index
   * @returns {Promise<void>}
   * @private
   */
  async _getManyToManyList({parent, child}, rest = {}, index) {
    const gs = await this._getGroupedManyToManyList({
      rest,
      index,
      child,
      parentIds: parent.map(p => p[this.columnToAlias?.[this.pks[0].cn] || this.pks[0].cn])
    });
    parent.forEach((row, i) => {
      row[`${this.dbModels?.[child]?._tn || child}MMList`] = gs[i] || [];
    })

  }

  public async _getGroupedManyToManyList({rest = {}, index = 0, child, parentIds}) {
    const {where, limit, offset, sort, ...restArgs} = this._getChildListArgs(rest, index, child, 'm');
    let {fields} = restArgs;
    const {tn, cn, vtn, vcn, vrcn, rtn, rcn} = this.manyToManyRelations.find(({rtn}) => rtn === child) || {};
    // @ts-ignore
    // const _cn = this.dbModels[tn].columnToAlias?.[cn];

    if (fields !== '*' && fields.split(',').indexOf(cn) === -1) {
      fields += ',' + cn;
    }


    const childs = await this._run(this.dbDriver.union(
      parentIds.map(id => {
        const query =
          this
            .dbDriver(this.dbModels[child].tnPath)
            .join(vtn, `${vtn}.${vrcn}`, `${rtn}.${rcn}`)
            .where(`${vtn}.${vcn}`, id) // p[this.columnToAlias?.[this.pks[0].cn] || this.pks[0].cn])
            .xwhere(where, this.dbModels[child].selectQuery(''))
            .select({[`${tn}_${vcn}`]: `${vtn}.${vcn}`, ...this.dbModels[child].selectQuery(fields)}) // ...fields.split(','));

        this._paginateAndSort(query, {sort, limit, offset}, null, true);
        return this.isSqlite() ? this.dbDriver.select().from(query) : query;
      }), !this.isSqlite()
    ));

    const gs = _.groupBy(childs, `${tn}_${vcn}`);
    return parentIds.map(id => gs[id] || [])
  }

  /**
   * Gets child rows for a parent row in this table
   *
   * @param {Object} args
   * @param {String} args.child - child table name
   * @param {String} args.parentId - pk
   * @param {String} [args.fields=*] - commas separated column names of this table
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object[]>} return child rows
   */
  async hasManyChildren({
                          child,
                          parentId,
                          conditionGraph = null,
                          ...args
                        }: XcFilterWithAlias & { child: string, parentId: any }) {
    try {
      const {where, limit, offset, sort, ...restArgs} = this._getListArgs(args);
      let {fields} = restArgs;
      const {cn} = this.hasManyRelations.find(({tn}) => tn === child) || {};

      if (fields === '*') {
        fields = `${child}.*`
      }

      const query = this.dbDriver(this.dbModels[child].tnPath)
        // .select(...fields.split(','))
        .select(this.dbModels?.[child]?.selectQuery(fields) || fields)
        .where(cn, parentId)
        .conditionGraph(conditionGraph)
        .xwhere(where, this.selectQuery(''));

      this._paginateAndSort(query, {limit, offset, sort});
      return this._run(query);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Gets parent list along with children list
   *
   * @param {Object} args
   * @param {String} args.childs - comma separated child table names
   * @param {String} [args.fields=*] - commas separated column names of this table
   * @param {String} [args.fields*=*] - commas separated column names of child table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.where*] - where clause with conditions within ()(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.limit*] -  number of rows to be limited  of child table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.offset*] - offset from which to get the number of rows of child table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @param {String} [args.sort*] - comma separated column names where each column name is cn ascending and -cn is cn descending(* is a natural number 'i' where i is index of child table in comma separated list)
   * @returns {Promise<Object[]>}
   */

  // todo : add conditionGraph
  async hasManyList({childs = '', where, fields, f, ...rest}) {
    fields = fields || f || '*';
    try {

      if (fields !== '*' && fields.split(',').indexOf(this.pks[0].cn) === -1) {
        fields += ',' + this.pks[0].cn;
      }

      const parent = await this.list({childs, where, fields, ...rest});
      if (parent && parent.length) {
        await Promise.all([...new Set(childs.split('.'))].map((child, index) => child && this._getChildListInParent({
          parent,
          child
        }, rest, index)));
      }
      return parent;
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Gets parent list along with children list and parent
   *
   * @param {Object} args
   * @param {String} args.childs - comma separated child table naes
   * @param {String} [args.fields=*] - commas separated column names of this table
   * @param {String} [args.fields*=*] - commas separated column names of child table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.where*] - where clause with conditions within ()(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.limit*] -  number of rows to be limited  of child table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.offset*] - offset from which to get the number of rows of child table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @param {String} [args.sort*] - comma separated column names where each column name is cn ascending and -cn is cn descending(* is a natural number 'i' where i is index of child table in comma separated list)
   * @returns {Promise<Object[]>}
   */

  // todo : add conditionGraph
  // todo : implement nestedread
  async nestedList({hm: childs = '', bt: parents = '', mm: many = '', where, fields: fields1, f, ...rest}) {
    let fields = fields1 || f || '*';
    try {

      if (fields !== '*' && this.pks[0] && fields.split(',').indexOf(this.pks?.[0]?.cn) === -1) {
        fields += ',' + this.pks[0].cn;
      }

      for (const parent of parents.split(',')) {
        const {cn} = this.belongsToRelations.find(({rtn}) => rtn === parent) || {};
        if (fields !== '*' && fields.split(',').indexOf(cn) === -1) {
          fields += ',' + cn;
        }
      }


      const items = await this.list({childs, where, fields, ...rest});

      if (items && items.length) {
        await Promise.all([...new Set(childs.split(','))].map((child, index) => child && this._getChildListInParent({
          parent: items,
          child
        }, rest, index)));
      }

      await Promise.all(parents.split(',').map((parent, index): any => {
        if (!parent) {
          return;
        }
        const {cn, rcn} = this.belongsToRelations.find(({rtn}) => rtn === parent) || {};
        const parentIds = [...new Set(items.map(c => c[cn] || c[this.columnToAlias[cn]]))];
        return this._belongsTo({parent, rcn, parentIds, childs: items, cn, ...rest}, index);
      }))


      if (items && items.length) {
        await Promise.all([...new Set(many.split(','))].map((child, index) => child && this._getManyToManyList({
          parent: items,
          child
        }, rest, index)));
      }


      return items;
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  async nestedRead(id, {hm: childs = '', bt: parents = '', mm: many = '', where, fields: fields1, f, ...rest}) {


    let fields = fields1 || f || '*';
    try {

      // todo: use fields in readbyPk
      if (fields !== '*' && this.pks[0] && fields.split(',').indexOf(this.pks[0].cn) === -1) {
        fields += ',' + this.pks[0].cn;
      }


      const item = await this.readByPk(id);
      if (!item) return item;

      for (const parent of parents.split(',')) {
        const {cn} = this.belongsToRelations.find(({rtn}) => rtn === parent) || {};
        if (fields !== '*' && fields.split(',').indexOf(cn) === -1) {
          fields += ',' + cn;
        }
      }


      const items = Object.keys(item).length ? [item] : [];

      if (items && items.length) {
        await Promise.all([...new Set(childs.split(','))].map((child, index) => child && this._getChildListInParent({
          parent: items,
          child
        }, rest, index)));
      }

      await Promise.all(parents.split(',').map((parent, index): any => {
        if (!parent) {
          return;
        }
        const {cn, rcn} = this.belongsToRelations.find(({rtn}) => rtn === parent) || {};
        const parentIds = [...new Set(items.map(c => c[cn] || c[this.columnToAlias[cn]]))];
        return this._belongsTo({parent, rcn, parentIds, childs: items, cn, ...rest}, index);
      }))


      if (items && items.length) {
        await Promise.all([...new Set(many.split(','))].map((child, index) => child && this._getManyToManyList({
          parent: items,
          child
        }, rest, index)));
      }


      return item;
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  // todo: naming
  public m2mNotChildren({pid = null, assoc = null, ...args}): Promise<any> {
    if (pid === null || assoc === null) {
      return null;
    }
    // @ts-ignore
    const {tn, cn, vtn, vcn, vrcn, rtn, rcn} = this.manyToManyRelations.find(({vtn}) => assoc === vtn) || {};
    const childModel = this.dbModels[rtn];

    const {fields, where, limit, offset, sort, condition, conditionGraph = null} = childModel._getListArgs(args);

    const query = childModel.$db
      .select(childModel.selectQuery(fields))
      .xwhere(where, childModel.selectQuery(''))
      .condition(condition, childModel.selectQuery(''))
      .conditionGraph(conditionGraph)
      .whereNotIn(rcn,
        childModel.dbDriver(this.dbModels[rtn].tnPath)
          .select(`${rtn}.${rcn}`)
          .join(vtn, `${rtn}.${rcn}`, `${vtn}.${vrcn}`)
          .where(`${vtn}.${vcn}`, pid)
      );
    childModel._paginateAndSort(query, {limit, offset, sort});

    return this._run(query);
  }


  // todo: naming
  public m2mNotChildrenCount({pid = null, assoc = null, ...args}): Promise<any> {

    if (pid === null || assoc === null) {
      return null;
    }
    // @ts-ignore
    const {tn, cn, vtn, vcn, vrcn, rtn, rcn} = this.manyToManyRelations.find(({vtn}) => assoc === vtn) || {};
    const childModel = this.dbModels[rtn];

    const {where, condition, conditionGraph = null} = childModel._getListArgs(args);

    const query = childModel.$db
      .count(`${rcn} as count`)
      .xwhere(where, childModel.selectQuery(''))
      .condition(condition, childModel.selectQuery(''))
      .conditionGraph(conditionGraph)
      .whereNotIn(rcn,
        childModel.dbDriver(this.dbModels[rtn].tnPath)
          .select(`${rtn}.${rcn}`)
          .join(vtn, `${rtn}.${rcn}`, `${vtn}.${vrcn}`)
          .where(`${vtn}.${vcn}`, pid)
      ).first();

    return this._run(query);
  }


  /**
   * Gets child list along with its parent
   *
   * @param {Object} args
   * @param {String} args.parents - comma separated parent table names
   * @param {String} [args.fields=*] - commas separated column names of this table
   * @param {String} [args.fields*=*] - commas separated column names of parent table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object[]>}
   */

  // todo : add conditionGraph
  async belongsTo({parents, where, fields, f, ...rest}) {
    fields = fields || f || '*';
    try {

      for (const parent of parents.split('~')) {
        const {cn} = this.belongsToRelations.find(({rtn}) => rtn === parent) || {};
        if (fields !== '*' && fields.split(',').indexOf(cn) === -1) {
          fields += ',' + cn;
        }
      }

      const childs = await this.list({where, fields, ...rest});


      await Promise.all(parents.split('~').map((parent, index) => {
        const {cn, rcn} = this.belongsToRelations.find(({rtn}) => rtn === parent) || {};
        const parentIds = [...new Set(childs.map(c => c[cn] || c[this.columnToAlias[cn]]))];
        return this._belongsTo({parent, rcn, parentIds, childs, cn, ...rest}, index);
      }))

      return childs;
    } catch (e) {
      console.log(e);
      throw e;
    }
  }


  /**
   * Get parent and map to input child
   *
   * @param {String} parent - parent table name
   * @param {Object} childs - children list
   * @param {Object} rest - index suffixed fields, limit, offset, where and sort
   * @param index - child table index
   * @param {String} [args.fields*=*] - commas separated column names of parent table(* is a natural number 'i' where i is index of child table in comma separated list)
   * @returns {Promise<void>}
   * @private
   */
  async _belongsTo({parent, rcn, parentIds, childs, cn, ...rest}, index) {
    let {fields} = this._getChildListArgs(rest, index, parent, 'b');
    if (fields !== '*' && fields.split(',').indexOf(rcn) === -1) {
      fields += ',' + rcn;
    }

    const parents = await this._run(
      this.dbDriver(this.dbModels[parent].tnPath)
        // .select(...fields.split(',')
        .select(
          this.dbModels[parent].selectQuery(fields)
        ).whereIn(rcn, parentIds));

    const gs = _.groupBy(parents, this.dbModels[parent]?.columnToAlias?.[rcn] || rcn);

    childs.forEach(row => {
      row[`${this.dbModels?.[parent]?._tn || parent}Read`] = gs[row[this?.columnToAlias?.[cn] || cn]]?.[0];
    })
  }

  /**
   * Returns key value paired grouped children list
   *
   * @param {Object} args
   * @param {String} args.child - child table name
   * @param {String[]} ids  - array of parent primary keys
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object.<string, Object[]>>}  key will be parent pk and value will be child list
   */
  async hasManyListGQL({child, ids, ...rest}) {
    try {
      const {where, limit, offset, conditionGraph, sort, ...restArgs} = this._getChildListArgs(rest);
      let {fields} = restArgs;

      const {cn} = this.hasManyRelations.find(({tn}) => tn === child) || {};

      if (fields !== '*' && fields.split(',').indexOf(cn) === -1) {
        fields += ',' + cn;
      }

      fields = fields.split(',').map(c => `${child}.${c}`).join(',')

      const childs = await this._run(this._paginateAndSort(this.dbDriver.union(
        ids.map(p => {
          const query = this
            .dbDriver(this.dbModels[child].tnPath)
            .where({[cn]: p})
            .conditionGraph(conditionGraph)
            .xwhere(where, this.selectQuery(''))
            // .select(...fields.split(','));
            .select(this.dbModels?.[child]?.selectQuery(fields));

          this._paginateAndSort(query, {limit, offset}, child);
          return this.isSqlite() ? this.dbDriver.select().from(query) : query;
        }), !this.isSqlite()
      ), {sort, limit: 1000} as any, child));


      // return _.groupBy(childs, cn);
      return _.groupBy(childs, this.dbModels?.[child]?.columnToAlias[cn]);

    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  isSqlite() {
    return this.clientType === 'sqlite3';
  }

  isMssql() {
    return this.clientType === 'mssql';
  }

  /**
   * Returns key value paired grouped children list
   *
   * @param {Object} args
   * @param {String} args.child - child table name
   * @param {String[]} ids  - array of parent primary keys
   * @param {String} [args.where]  - where clause with conditions within ()
   * @param {String} [args.limit]  - number of rows to be limited (has default,min,max values in config)
   * @param {String} [args.offset] - offset from which to get the number of rows
   * @param {String} [args.sort]   - comma separated column names where each column name is cn ascending and -cn is cn descending
   * @returns {Promise<Object.<string, Object[]>>}  key will be parent pk and value will be child list
   */
  async hasManyListCount({child, ids, ...rest}) {
    try {
      const {where, conditionGraph} = this._getChildListArgs(rest);

      const {cn} = this.hasManyRelations.find(({tn}) => tn === child) || {};

      const childs = await this._run(this.dbDriver.unionAll(
        ids.map(p => {
          const query = this
            .dbDriver(this.dbModels[child].tnPath)
            .where({[cn]: p})
            .xwhere(where, this.selectQuery(''))
            .conditionGraph(conditionGraph)
            .count(`${cn} as count`)
            .first();
          return this.isSqlite() ? this.dbDriver.select().from(query) : query;
        }), !this.isSqlite()
      ));

      return childs.map(({count}) => count);
      // return _.groupBy(childs, cn);

    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  /**
   * Adds default params to limit, ofgste and sort params
   *
   * @param {Object} query - knex query builder
   * @param {Object} args
   * @param {string} args.limit - limit
   * @param {string} args.offset - offset
   * @param {string} args.sort - sort
   * @returns {Object} query appended with paginate and sort params
   * @private
   */
  _paginateAndSort(query, {limit = 20, offset = 0, sort = ''}: XcFilter, table?: string, isUnion?: boolean) {
    query.offset(offset)
      .limit(limit);

    if (!table && !sort && this.clientType === 'mssql' && !isUnion) {
      sort = this.columns.filter(c => c.pk).map(c => `${c.cn}`).join(',') || `${this.columns[0].cn}`;
    }


    if (sort) {
      sort.split(',').forEach(o => {
        if (o[0] === '-') {
          query.orderBy(this.columnToAlias[o.slice(1)] || o.slice(1), 'desc')
        } else {
          query.orderBy(this.columnToAlias[o] || o, 'asc')
        }
      })
    }


    return query;
  }

  /**
   * Runs a query built by knex, measure and logs time
   *
   * @param query
   * @returns {Promise<*>}
   * @private
   */
  async _run(query) {
    try {
      if (this.config.log) {
        const q = query.toQuery();
        console.time(q);
        const data = await query;
        console.timeEnd(q);
        return data;
      } else {
        return await query;
      }
    } catch (e) {
      throw e;
    }
  }

  /**
   * Gets the default list of args for querying a table
   *
   * @param {Object} args - fields,where,limit,offset,sort indexed
   * @returns {Object} consisting of fields,where,limit,offset,sort
   * @private
   */
  _getListArgs(args: XcFilterWithAlias): XcFilter {
    const obj: XcFilter = {};
    obj.where = args.where || args.w || '';
    obj.having = args.having || args.h || '';
    obj.condition = args.condition || args.c || {};
    obj.conditionGraph = args.conditionGraph || {};
    obj.limit = Math.max(Math.min(args.limit || args.l || this.config.limitDefault, this.config.limitMax), this.config.limitMin);
    obj.offset = args.offset || args.o || 0;
    obj.fields = args.fields || args.f || '*';
    obj.sort = args.sort || args.s;
    return obj;
  }

  /**
   * Gets the default args for child list
   *
   * @param {Object} args - fields,where,limit,offset,sort indexed
   * @param {Number} index
   * @returns {Object} consisting of fields*,where*,limit*,offset*,sort*
   * @private
   */
  _getChildListArgs(args: any, index?: number, child?: string, prefix = '') {
    index++;
    const obj: XcFilter = {};
    obj.where = args[`${prefix}where${index}`] || args[`w${index}`] || '';
    obj.limit = Math.max(Math.min(args[`${prefix}limit${index}`] || args[`${prefix}l${index}`] || this.config.limitDefault, this.config.limitMax), this.config.limitMin);
    obj.offset = args[`${prefix}offset${index}`] || args[`${prefix}o${index}`] || 0;
    obj.fields = args[`${prefix}fields${index}`] || args[`f${index}`];
    obj.sort = args[`${prefix}sort${index}`] || args[`${prefix}s${index}`];

    obj.fields = obj.fields ? `${obj.fields},${this.getTablePKandPVFields(child)}` : this.getTablePKandPVFields(child);

    return obj;
  }

  private getTablePKandPVFields(child: string) {
    return child ?
      (this.dbModels[child]?.columns?.filter(col => col.pk || col.pv).map(col => col.cn) || ['*']).join(',')
      : '*';
  }


// @ts-ignore
  public selectQuery(fields) {
    const fieldsArr = fields.split(',');
    const selectObj = this.columns?.reduce((selectObj, col) => {
      if (
        !fields
        || fieldsArr.includes('*')
        || fieldsArr.includes(`${this.tn}.*`)
        || fieldsArr.includes(col._cn)
        || fieldsArr.includes(col.cn)
      ) {
        selectObj[col._cn] = `${this.tn}.${col.cn}`;
      }
      return selectObj;
    }, {}) || '*';


    return selectObj;

  }

  // @ts-ignore
  public get columnToAlias() {
    return this.columns?.reduce((selectObj, col) => {
      selectObj[col.cn] = col._cn;
      return selectObj;
    }, {});
  }

  // @ts-ignore
  public get aliasToColumn() {
    return this.columns?.reduce((selectObj, col) => {
      selectObj[col._cn] = col.cn;
      return selectObj;
    }, {});
  }

  // @ts-ignore
  public mapAliasToColumn(data) {
    const obj = {};
    for (const col of this.columns) {
      if (col._cn in data) {
        obj[col.cn] = data[col._cn];
      } else if (col.cn in data) {
        obj[col.cn] = data[col.cn];
      }
    }
    return obj;
  }

  protected get defaultNestedBtQueryParams(): any {
    return Object.entries(this.defaultNestedQueryParams || {}).reduce((paramsObj, [key, val]) => {
      if (key.startsWith('bfield') || key.startsWith('bf') || key === 'bt') {
        return {...paramsObj, [key]: val}
      }
      return paramsObj;
    }, {})
  }

  protected get defaultNestedQueryParams(): any {
    if (!this._defaultNestedQueryParams) {
      // generate default nested fields args based on virtual column list
      try {
        const nestedFields: {
          [key: string]: string[]
        } = (this.virtualColumns || []).reduce((obj, vc) => {
          if (vc.hm) {
            obj.hm.push(vc.hm.tn)
          } else if (vc.bt) {
            obj.bt.push(vc.bt.rtn)
          } else if (vc.mm) {
            obj.mm.push(vc.mm.rtn)
          }
          return obj
        }, {hm: [], bt: [], mm: []})

        // todo: handle if virtual column missing
        // construct fields args based on lookup columns
        const fieldsObj = (this.virtualColumns || []).reduce((obj, vc) => {
          if (!vc.lk) {
            return obj
          }

          let key
          let index
          let column

          switch (vc.lk.type) {
            case 'mm':
              index = nestedFields.mm.indexOf(vc.lk.ltn) + 1
              key = `mfields${index}`
              column = vc.lk.lcn
              break
            case 'hm':
              index = nestedFields.hm.indexOf(vc.lk.ltn) + 1
              key = `hfields${index}`
              column = vc.lk.lcn
              break
            case 'bt':
              index = nestedFields.bt.indexOf(vc.lk.ltn) + 1
              key = `bfields${index}`
              column = vc.lk.lcn
              break
          }

          if (index && column) {
            obj[key] = `${obj[key] ? `${obj[key]},` : ''}${column}`
          }

          return obj
        }, {})
        this._defaultNestedQueryParams = {
          ...Object.entries(nestedFields).reduce((ro, [k, a]) => ({...ro, [k]: a.join(',')}), {}),
          ...fieldsObj
        }
      } catch (e) {
        return {}
      }
    }
    return this._defaultNestedQueryParams;
  }

  protected get selectFormulas() {
    if (!this._selectFormulas) {
      this._selectFormulas = (this.virtualColumns || [])?.reduce((arr, v) => {
        if (v.formula?.value && !v.formula?.error?.length) {
          arr.push(formulaQueryBuilder(v.formula?.tree, v._cn, this.dbDriver, this.aliasToColumn))
        }
        return arr;
      }, [])
    }
    return this._selectFormulas
  }

  protected get selectFormulasObj() {
    if (!this._selectFormulasObj) {
      this._selectFormulasObj = (this.virtualColumns || [])?.reduce((obj, v) => {
        if (v.formula?.value && !v.formula?.error?.length) {
          obj[v._cn] = formulaQueryBuilder(v.formula?.tree, null, this.dbDriver, this.aliasToColumn);
        }
        return obj;
      }, {})
    }
    return this._selectFormulasObj;
  }

  // todo: optimize
  protected get selectRollups() {
    return (this.virtualColumns || [])?.reduce((arr, v) => {
      if (v.rl) {
        arr.push(
          genRollupSelect({knex: this.dbDriver, rollup: v.rl}).as(v._cn)
        );
      }
      return arr;
    }, [])
  }
}




export {BaseModelSql};
/**
 * @copyright Copyright (c) 2021, Xgene Cloud Ltd
 *
 * @author Naveen MR <oof1lab@gmail.com>
 * @author Pranav C Balan <pranavxc@gmail.com>
 *
 * @license GNU AGPL version 3 or any later version
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 */
