"use strict";

plugin.consumes = [
    "connect.static", 
    "connect",
    "preview.handler",
    "connect.render",
    "connect.render.ejs"
];
plugin.provides = ["api", "passport"];

module.exports = plugin;
    
var fs = require("fs");
var http = require("http");
var assert = require("assert");
var async = require("async");
var join = require("path").join;
var extend = require("util")._extend;
var resolve = require("path").resolve;
var basename = require("path").basename;
var frontdoor = require("frontdoor");

function plugin(options, imports, register) {
    var previewHandler = imports["preview.handler"];
    var statics = imports["connect.static"];
    
    assert(options.workspaceDir, "Option 'workspaceDir' is required");
    assert(options.options, "Option 'options' is required");
    

    // serve index.html
    statics.addStatics([{
        path: __dirname + "/www",
        mount: "/"
    }]);
    
    statics.addStatics([{
        path: __dirname + "/../../configs",
        mount: "/configs"
    }]);

    statics.addStatics([{
        path: __dirname + "/../../test/resources",
        mount: "/test"
    }]);

    var api = frontdoor();
    imports.connect.use(api);
    
    api.get("/", function(req, res, next) {
        res.writeHead(302, { "Location": options.sdk ? "/ide.html" : "/static/places.html" });
        res.end();
    });
    
    api.get("/ide.html", {
        params: {
            workspacetype: {
                source: "query",
                optional: true
            },
            devel: {
                source: "query",
                optional: true
            },
            collab: {
                type: "number",
                optional: true,
                source: "query"
            },
            nocollab: {
                type: "number",
                optional: true,
                source: "query"
            },
            debug: {
                optional: true,
                source: "query"
            },
            packed: {
                source: "query",
                type: "number",
                optional: true
            }, 
            token: {
                source: "query",
                optional: true
            },  
            w: {
                source: "query",
                optional: true
            },
            sessionId: {
                source: "query",
                optional: true
            }
        }
    }, function(req, res, next) {
        var configType = null;
        if (req.params.workspacetype)
            configType = "workspace-" + req.params.workspacetype;
        else if (req.params.devel)
            configType = "devel";

        var configName = getConfigName(configType, options);
        console.log('config name: ' + configName);

        var collab = options.collab && req.params.collab !== 0 && req.params.nocollab != 1;

        api.authenticate()(req, res, function() {
            var opts = extend({}, options);
            opts.options.collab = collab;
            if (req.params.packed == 1)
                opts.packed = opts.options.packed = true;
            
            var cdn = options.options.cdn;
            options.options.themePrefix = "/static/" + cdn.version + "/skin/" + configName;
            options.options.workerPrefix = "/static/" + cdn.version + "/worker";
            options.options.CORSWorkerPrefix = opts.packed ? "/static/" + cdn.version + "/worker" : "";
            
            api.updatConfig(opts.options, {
                w: req.params.w,
                token: req.user.token
            });

            var user = opts.options.extendOptions.user;
            user.id = req.user.id;
            user.name = req.user.name;
            user.email = req.user.email;
            user.fullname = req.user.fullname;

            opts.readonly = opts.options.readonly = opts.options.extendOptions.readonly = req.user.readonly;
            
            opts.options.debug = req.params.debug !== undefined;
            res.setHeader("Cache-Control", "no-cache, no-store");
            res.render(__dirname + "/views/server.html.ejs", {
                architectConfig: getConfig(configType, opts),
                configName: configName,
                packed: opts.packed,
                version: opts.version
            }, next);
        });
    });
    
    api.get("/_ping", function(params, callback) {
        return callback(null, {"ping": "pong"}); 
    });
    
    api.get("/preview/:path*", [
        function(req, res, next) {
            req.projectSession = {
                pid: 1
            };
            req.session = {};
            api.authenticate()(req, res, next);
        },
        previewHandler.getProxyUrl(function() {
            return {
                url: "http://localhost:" + options.options.port + "/vfs"
            };
        }),
        previewHandler.proxyCall()
    ]);
    
    api.get("/preview", function(req, res, next) {
        res.redirect(req.url + "/");
    });

    api.get("/vfs-root", function(req, res, next) {
        if (!options.options.testing)
            return next();
            
        res.writeHead(200, {"Content-Type": "application/javascript"});
        res.end("define(function(require, exports, module) { return '" 
            + options.workspaceDir + "'; });");
    });
    api.get("/vfs-home", function(req, res, next) {
        if (!options.options.testing)
            return next();
            
        res.writeHead(200, {"Content-Type": "application/javascript"});
        res.end("define(function(require, exports, module) { return '" 
            + process.env.HOME + "'; });");
    });

    api.get("/update", function(req, res, next) {
        res.writeHead(200, {
            "Content-Type": "application/javascript", 
            "Access-Control-Allow-Origin": "*"
        });
        var path = resolve(__dirname + "/../../build/output/latest.tar.gz");
        fs.readlink(path, function(err, target) {
            if (err) return next(err);
            
            res.end((target || "").split(".")[0]);
        });
    });
    
    api.get("/update/:path*", function(req, res, next) {
        var filename = req.params.path;
        var path = resolve(__dirname + "/../../build/output/" + filename);
        
        var stream = fs.createReadStream(path);
        stream.on("error", function(err) {
            next(err);
        });
        stream.on("data", function(data) {
            if (!res.headersSent)
                res.writeHead(200, {"Content-Type": "application/octet-stream"});
                
            res.write(data);
        });
        stream.on("end", function(data) {
            res.end();
        });
    });

    api.get("/configs/require_config.js", function(req, res, next) {
        var config = res.getOptions().requirejsConfig || {};
        
        res.writeHead(200, {"Content-Type": "application/javascript"});
        res.end("requirejs.config(" + JSON.stringify(config) + ");");
    });
    
    api.get("/test/all.json", function(req, res, next) {
        var base = __dirname + "/../../";
        var blacklistfile = base + "/test/blacklist.txt";
        var filefinder = require(base + "/test/lib/filefinder.js");
        filefinder.find(base, "plugins", ".*_test.js", blacklistfile, function(err, result) {
            result.all = result.list.concat(result.blacklist);
            async.filterSeries(result.list, function(file, next) {
                fs.readFile(file, "utf8", function(err, file) {
                    if (err) return next(false);
                    if (file.match(/^"use server"/m) && !file.match(/^"use client"/m))
                        return next(false);
                    next(file.match(/^define\(|^require\(\[/m));
                });
            }, function(files) {
                result.list = files;
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify(result, null, 2));
            });
        });
    });
    
    api.get("/api.json", {name: "api"}, frontdoor.middleware.describeApi(api));

    api.get("/api/project/:pid/persistent/:apikey", {
        params: {
            pid: { type: "number" },
            apikey: { type: "string" }
        }
    }, persistentDataApiMock);
    api.put("/api/project/:pid/persistent/:apikey", {
        params: {
            data: { type: "string", source: "body" },
            pid: { type: "number" },
            apikey: { type: "string" },
        }
    }, persistentDataApiMock);
    api.get("/api/user/persistent/:apikey", {
        params: {
            apikey: { type: "string" }
        }
    }, persistentDataApiMock);
    api.put("/api/user/persistent/:apikey", {
        params: {
            data: { type: "string", source: "body" },
            apikey: { type: "string" },
        }
    }, persistentDataApiMock);
    
    function persistentDataApiMock(req, res, next) {
        var name = (req.params.pid || 0) + "-" + req.params.apikey;
        var data = req.params.data;
        console.log(name, data)
        if (/[^\w+=\-]/.test(name))
            return next(new Error("Invalid apikey"));
        var path = join(options.installPath, ".c9", "persistent");
        var method = req.method.toLowerCase()
        if (method == "get") {
            res.writeHead(200, {"Content-Type": "application/octet-stream"});
            var stream = fs.createReadStream(path + "/" + name);
            stream.pipe(res);
        } else if (method == "put") {
            require("mkdirp")(path, function(e) {
                fs.writeFile(path + "/" + name, data, "", function(err) {
                    if (err) return next(err);
                    res.writeHead(200, {"Content-Type": "application/octet-stream"});
                    res.end("");
                });
            });
        }
    }
    
    api.authenticate = api.authenticate || function() {
        return function(req, response, next) {
            var token = req.params.sessionId || req.params.access_token || req.cookies.sessionId;
            var config = options.options;
            var url = config.apiUrl + "/user-details?" +
                    "projectId=" + config.extendOptions.project.id;
            if (token) url += "&sessionId=" + token;

            http.get(url, function(res) {
                var body = "";
                res.on("data", function(chunk) {
                    body += chunk.toString();
                });
                res.on("end", function() {
                    if (res.statusCode == 404) {
                        try {
                            var details = JSON.parse(body);
                        } catch (e) {
                            return showError(e.message);
                        }
                        if (details.message == 'No such project') {
                            showError(
                                'Specified project does not exist. Probably, the url is wrong. ' +
                                    'If you are sure it is correct, please, send us a message.'
                            );
                        } else {
                            showError('We got an error: ' + body);
                        }
                    } else if (res.statusCode < 200 || res.statusCode >= 300) {
                        showError('We got an error: ' + body);
                    } else {
                        try {
                            details = JSON.parse(body);
                        } catch (e) {
                            return showError(e.message);
                        }
                        req.user = {
                            id: details.id,
                            name: details.name,
                            email: details.email,
                            fullname: details.fullname,
                            readonly: details.readonly,
                            token: details.token
                        };
                        if (req.cookies.sessionId != details.token) {
                            response.setHeader(
                                'Set-Cookie',
                                'sessionId=' +
                                    details.token + '; path=/; domain=' + base(req.headers.host)
                            );
                        }
                        next();
                    }
                });

                function base(host) {
                    // ip address
                    var match = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/.exec(host);
                    if (match) return match[1];
                    else {
                        // domain name like someide.ether.camp:8080
                        match = /^[\w\-]+(\.[\w\-\.]+)(:\d+)?$/.exec(host);
                        return match ? match[1] : host;
                    }
                }
            }).on("error", function(e) {
                showError(e.message);
            });

            function showError(err) {
                console.error(err);
                response.writeHead(500);
                response.end(err);
            }
        };
    };
    api.ensureAdmin = api.ensureAdmin || function() {
        return function(req, res, next) { 
            next(); 
        };
    };
    api.getVfsOptions = api.getVfsOptions || function(user, pid) {
        if (!options._projects) {
            options._projects = [options.workspaceDir];
        }
        //var wd = options._projects[pid] || options._projects[0];
        var wd = options.workspaceDir;
        
        return {
            workspaceDir: wd,
            extendOptions: {
                user: user,
                project: {
                    id: pid,
                    name: pid + "-" + wd
                },
                readonly: options.options.extendOptions.readonly
            }
        };
    };    
    api.updatConfig = api.updatConfig || function(opts, params) {
        var id = params.token;
        opts.accessToken = opts.extendToken = id || "token";
        opts.workspaceDir = params.w ? params.w : options.workspaceDir;
        opts.projectName = basename(opts.workspaceDir);
    };
    
    imports.connect.setGlobalOption("apiBaseUrl", "");

    register(null, {
        "api": api,
        "passport": {
            authenticate: function() {
                return function(req, res, next) {
                    req.user = extend({}, options.options.extendOptions.user);
                    next();
                };
            }
        }
    });
}

function getConfigName(requested, options) {
    var name;
    if (requested) {
        name = requested;
    }
    else if (options.workspaceType) {
        name = "workspace-" + options.workspaceType;
    }
    else if (options.options.client_config) {
        // pick up client config from settings, if present
        name = options.options.client_config;
    }
    else if (options.readonly) {
        name = "ether-camp-server-ro";
    }
    else {
        name = "ether-camp-server";
    }
    
    if (options.local)
        name += "-local";
    
    return name;
}

function getConfig(requested, options) {
    var filename = __dirname + "/../../configs/client-" + getConfigName(requested, options) + ".js";

    var installPath = options.settingDir || options.installPath || "";
    var workspaceDir = options.options.workspaceDir;
    var settings = {
        "user": join(installPath, "user.settings"),
        "project": join(options.local ? installPath : join(workspaceDir, ".c9"), "project.settings"),
        "state": join(options.local ? installPath : join(workspaceDir, ".c9"), "state.settings")
    };
    
    var fs = require("fs");
    for (var type in settings) {
        var data = "";
        try {
            data = fs.readFileSync(settings[type], "utf8");
        } catch (e) {
        }
        settings[type] = data;
    }
    options.options.settings = settings;
    
    return require(filename)(options.options);
}
