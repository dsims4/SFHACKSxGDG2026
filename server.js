// Load environment variables before reading any server setting below.
require("dotenv").config({
    path: [require("node:path").join(__dirname, ".env.local"), require("node:path").join(__dirname, ".env")]
});
// This integer is the TCP port where Express accepts connections.
const port = Number.parseInt(process.env.PORT || "3000", 10);
// This boolean enables production-only proxy, caching, and HTTPS behavior.
const isProduction = process.env.NODE_ENV === "production";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 through 65535.");
}

// These modules provide HTTP routing, HTML templates, security headers, and safe paths.
const express = require("express");
const nunjucks = require("nunjucks");
const helmet = require("helmet");
const path = require("path");

const publicRouter = require("./routes/public");
const { createViewerRouter } = require("./routes/viewer");
const { createDbViewerRouter } = require("./routes/dbviewer");
const { readConfig, startRSSBuilder } = require("./rss-builder/rss_builder");
const { readDatabaseConfig, createDatabasePool, waitForDatabase } = require("./services/db");
const databaseConfig = readDatabaseConfig();
const rssConfig = readConfig();
const database = databaseConfig ? createDatabasePool(databaseConfig) : null;

// This object is the complete Express application configured below.
const app = express();

// Production hosting is expected to use one trusted reverse proxy.
if (isProduction) {
    app.set("trust proxy", 1);
}

/*
 * This function sends an error in the format expected by the requested address.
 *
 * API requests receive JSON so browser JavaScript can read the message. Normal
 * page requests receive plain text.
 *
 * Returns the Express response object after sending the error.
 */
/**
 * @param {import("express").Request} req - The request whose path selects the format.
 * @param {import("express").Response} res - The response used to send the error.
 * @param {number} status - The HTTP error status code.
 * @param {string} message - The safe public error message.
 * @returns {import("express").Response} Completed error response.
 */
function sendErrorResponse(req, res, status, message) {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
        return res.status(status).json({ error: message });
    }

    return res.status(status).send(message);
}

nunjucks.configure(path.join(__dirname, "views"), {
    autoescape: true,
    express: app,
    noCache: !isProduction
});

// Apply security headers and body limits before any route runs.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            upgradeInsecureRequests: isProduction ? [] : null
        }
    },
    referrerPolicy: {
        policy: "same-origin"
    },
    strictTransportSecurity: isProduction ? {} : false
}));

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({
    extended: true,
    limit: "10kb"
}));
app.use(express.static(path.join(__dirname, "public")));

// Mount the public pages before the shared error handlers.
app.use("/", publicRouter);
app.use("/", createViewerRouter(database));
app.use("/", createDbViewerRouter(database));
/*
 * Requests that reached this point did not match any application route.
 */
app.use((req, res) => {
    return sendErrorResponse(req, res, 404, "Page not found.");
});

/*
 * This final error handler turns known body-reading failures and unexpected
 * errors into consistent responses.
 *
 * If a response has already started, control is passed to Express instead of
 * trying to send a second response, which would itself cause an error.
 */
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error.type === "entity.too.large") {
        return sendErrorResponse(
            req,
            res,
            413,
            "The request body was too large."
        );
    }

    if (error.type === "entity.parse.failed") {
        return sendErrorResponse(
            req,
            res,
            400,
            "The request body was invalid."
        );
    }

    console.error(error);
    return sendErrorResponse(
        req,
        res,
        500,
        "There was an internal server error."
    );
});

// Start the server after middleware and routes are ready.
let rssBuilder = null;
let shuttingDown = false;
const databaseController = new AbortController();
let databaseReady = Promise.resolve();

const server = app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
    if (!database) {
        console.log("Database disabled. Configure DATABASE_URL or a Cloud SQL connection to initialize it.");
        return;
    }

    databaseReady = waitForDatabase(database, databaseController.signal).then(() => {
        if (shuttingDown) return;
        console.log("PostgreSQL database initialized.");
        rssBuilder = startRSSBuilder(rssConfig, database);

        if (rssBuilder) {
            rssBuilder.done.catch((error) => {
                console.error("RSS builder stopped unexpectedly:", error);
                shutdown(1);
            });
        } else {
            console.log("RSS builder disabled. Configure TYPESENSE_API_KEY and TYPESENSE_URL to enable it.");
        }
    });
    databaseReady.catch((error) => {
        console.error("Database initialization stopped unexpectedly:", error);
        shutdown(1);
    });
});

// Cloud Run sends SIGTERM before stopping an instance. Cancel polling and close
// database connections along with the HTTP server.
async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    databaseController.abort();

    const timeout = setTimeout(() => process.exit(1), 9000);
    timeout.unref();

    try {
        const results = await Promise.allSettled([
            new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            }),
            rssBuilder?.stop(),
            databaseReady
        ]);
        await database?.end();
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        process.exitCode = exitCode;
    } catch (error) {
        console.error("Shutdown failed:", error);
        process.exitCode = 1;
    } finally {
        clearTimeout(timeout);
    }
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
