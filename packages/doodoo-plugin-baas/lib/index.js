const _ = require("lodash");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const decache = require("decache");
const Query = require("./query");

/**
 * Usage Example
 * plugin.js
 * 
module.exports = {
    baas: {
        auth: {
            Token: {
                secret: "doodoo",
                expires: "7 days"
            }
        },
        class: {
            public: {
                model: {
                    user: {
                        auth: "Token",
                        curd: ["add", "fetch"],
                        field: {
                            "app_id": ctx => {
                                return "xxx";
                            }
                        }
                    }
                }
            },
            home: {
                auth: ["Token"],
                model: {
                    todos: {
                        curd: ["add", "delete", "update", "fetch"]
                    }
                }
            }
        }
    }
};
 * 
 */

/**
 * 处理关联关系
 * @param {*} related
 */
function withRelateds(ctx) {
    let relateds = Query.getRelateds(ctx.query);
    // 过滤数组中的字符串
    const _relateds = [];
    for (const key in relateds) {
        if (_.isString(relateds[key])) {
            _relateds.push(relateds[key]);
            delete relateds[key];
        }
    }

    // 合并数组中同名对象
    relateds = _.reduceRight(relateds, (flattened, other) => {
        return _.merge(flattened, other);
    });

    const __relateds = [];
    for (const key in relateds) {
        __relateds.push({
            [key]: qb => {
                new Query(ctx, qb, relateds[key]);
            }
        });
    }

    return [].concat(_relateds, __relateds);
}

module.exports = options => {
    const router = doodoo.router;
    const pluginMTime = {};
    router.use("/plugin/baas/:moduleName", async (ctx, next) => {
        const { moduleName } = ctx.params;

        // plugin.js修改，重新加载
        const pluginFilePath = path.resolve(
            doodoo.getConf("app.root"),
            moduleName,
            "plugin.js"
        );
        const mTime = fs.statSync(pluginFilePath).mtime.getTime();
        if (pluginMTime[moduleName]) {
            if (pluginMTime[moduleName] < mTime) {
                decache(pluginFilePath);
                pluginMTime[moduleName] = mTime;
            }
        } else {
            pluginMTime[moduleName] = mTime;
        }

        // 获取baas配置信息
        const info = require(pluginFilePath);
        ctx.baasInfo = _.get(info, "baas");
        if (!ctx.baasInfo) {
            throw new Error(
                `PluginError: Module ${moduleName} Don't Support Baas`
            );
        }

        await next();
    });

    router.use("/plugin/baas/:moduleName/:className", async (ctx, next) => {
        const { moduleName, className } = ctx.params;

        // 获取class配置信息
        ctx.classInfo = _.get(ctx.baasInfo, `class.${className}`);
        if (!ctx.classInfo) {
            ctx.status = 401;
            throw new Error(
                `PluginError: Module ${moduleName} Class ${className} Unauthorized`
            );
        }

        // 检测访问权限
        ctx.auth = {};
        const auths = _.get(ctx.baasInfo, "auth");
        const classAuths = _.get(ctx.classInfo, "auth");
        if (classAuths) {
            for (const authName of classAuths) {
                const authToken = ctx.query[authName] || ctx.get(authName);
                if (!authToken) {
                    ctx.status = 401;
                    throw new Error(
                        `PluginError: Module ${moduleName} Class ${className} AuthName ${authName} Unauthorized`
                    );
                } else {
                    try {
                        const decoded = jwt.verify(
                            authToken,
                            _.get(auths, `${authName}.secret`)
                        );
                        ctx.auth[authName] = decoded;
                    } catch (err) {
                        ctx.status = 401;
                        throw new Error(
                            `PluginError: Module ${moduleName} Class ${className} AuthName ${authName} Unauthorized`
                        );
                    }
                }
            }
        }

        await next();
    });

    router.use(
        "/plugin/baas/:moduleName/:className/:modelName",
        async (ctx, next) => {
            const { moduleName, className, modelName } = ctx.params;
            const query = ctx.query;

            // 获取model配置信息
            ctx.modelInfo = _.get(ctx.classInfo, `model.${modelName}`);
            if (!ctx.modelInfo) {
                ctx.status = 401;
                throw new Error(
                    `PluginError: Module ${moduleName} Class ${className} Model ${modelName} Unauthorized`
                );
            }

            // 安全数据
            ctx.fields = {};
            // 获取filed配置信息
            ctx.fieldInfo = _.get(ctx.modelInfo, "field");
            if (ctx.fieldInfo) {
                const _fields = {};
                for (const key in ctx.fieldInfo) {
                    if (_.isFunction(ctx.fieldInfo[key])) {
                        _fields[key] = await ctx.fieldInfo[key](ctx);
                    } else {
                        _fields[key] = ctx.fieldInfo[key];
                    }
                }
                Object.assign(ctx.fields, _fields);
            }

            await next();
        }
    );

    router.post(
        "/plugin/baas/:moduleName/:className/:modelName/(add|save|update)",
        async (ctx, next) => {
            const { moduleName, className, modelName } = ctx.params;
            const saveType = ctx.params[0];
            const fields = Object.assign({}, ctx.post, ctx.fields);
            const curd = _.get(ctx.modelInfo, "curd");

            if (fields.id) {
                // 检测数据表是否可更新
                if (!curd || !_.includes(curd, "update")) {
                    throw new Error(
                        `PluginError: Module ${moduleName} Class ${className} Model ${modelName} No Permission Update`
                    );
                }
            } else {
                // 检测数据表是否可新增
                if (!curd || !_.includes(curd, "add")) {
                    throw new Error(
                        `PluginError: Module ${moduleName} Class ${className} Model ${modelName} No Permission Add`
                    );
                }
            }

            const result = await ctx
                .model(modelName)
                .forge(fields)
                .save();

            ctx.success(result);
        }
    );

    router.get(
        "/plugin/baas/:moduleName/:className/:modelName/(del|delete|destroy)",
        async (ctx, next) => {
            const { className, modelName } = ctx.params;
            const { forceDelete = false } = ctx.query;
            const query = ctx.query;
            const fields = ctx.fields;

            const curd = _.get(ctx.modelInfo, "curd");
            // 检测数据表是否可查询
            if (!curd || !_.includes(curd, "delete")) {
                throw new Error(
                    `PluginError: Module ${moduleName} Class ${className} Model ${modelName} No Permission Delete`
                );
            }

            const result = await ctx
                .model(modelName)
                .query(qb => {
                    if (!_.isEmpty(fields)) {
                        const table = qb._single.table;
                        qb.from(function() {
                            this.where(fields);
                            this.select()
                                .from(table)
                                .as(table);
                        });
                    }

                    new Query(ctx, qb, query);
                })
                .fetchAll();
            if (!result.length) {
                throw new Error(
                    `PluginError: Module ${moduleName} Class ${className} Model ${modelName} Del, Delete, Destroy Data Not Found`
                );
            }

            await doodoo.bookshelf.Collection.extend({
                model: ctx.model(modelName)
            })
                .forge(result)
                .invokeThen("destroy", {
                    hardDelete: forceDelete
                });

            ctx.success(result);
        }
    );

    router.get(
        "/plugin/baas/:moduleName/:className/:modelName/(fetch|fetchAll|fetchPage)",
        async (ctx, next) => {
            const { moduleName, className, modelName } = ctx.params;
            const query = ctx.query;
            const fields = ctx.fields;
            const fetchType = ctx.params[0];
            const { deleted = false, page = 1, pageSize } = ctx.query;

            const curd = _.get(ctx.modelInfo, "curd");
            // 检测数据表是否可查询
            if (!curd || !_.includes(curd, "fetch")) {
                throw new Error(
                    `PluginError: Module ${moduleName} Class ${className} Model ${modelName} No Permission Fetch`
                );
            }

            const option = {
                withRelated: withRelateds(ctx),
                withDeleted: deleted
            };
            if (fetchType === "fetchPage") {
                option.page = page;
                option.pageSize = pageSize;
            }

            let result = await ctx
                .model(modelName)
                .query(qb => {
                    if (!_.isEmpty(fields)) {
                        const table = qb._single.table;
                        qb.from(function() {
                            this.where(fields);
                            this.select()
                                .from(table)
                                .as(table);
                        });
                    }

                    new Query(ctx, qb, query);
                })
                [fetchType](option);
            // 加密数据
            try {
                const auths = _.get(ctx.baasInfo, "auth");
                const authName = _.get(ctx.modelInfo, "auth");
                if (authName) {
                    result = jwt.sign(result, auths[authName].secret, {
                        expiresIn: auths[authName].expires
                    });
                }
            } catch (err) {
                if (!_.isEmpty(result)) {
                    let type = typeof result;
                    if (_.isArray(result)) {
                        type = "Array";
                    }
                    // 部分数据不支持加密
                    throw new Error(
                        `PluginError: Module ${moduleName} Class ${className} Sign Secret Don't Support ${type}`
                    );
                }
            }

            ctx.success(result);
        }
    );
};
