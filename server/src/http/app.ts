import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { sql } from "kysely";
import type { ApiErrorBody } from "@clubcal/shared";
import { csrfProtection, sessionMiddleware } from "../auth/middleware.js";
import { config } from "../config.js";
import type { Db } from "../db/index.js";
import { HttpError, isExclusionViolation, isSerializationFailure, pgCode } from "../lib/errors.js";
import { log } from "../lib/log.js";
import type { JobQueue } from "../queue/boss.js";
import { authRoutes } from "./authRoutes.js";
import { clubRoutes } from "./clubRoutes.js";
import { eventRoutes } from "./eventRoutes.js";
import { miscRoutes } from "./miscRoutes.js";

export interface AppDeps {
  db: Db;
  queue: JobQueue;
  now?: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY === "true" ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "font-src": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "upgrade-insecure-requests": config.NODE_ENV === "production" ? [] : null,
        },
      },
      hsts: config.NODE_ENV === "production",
    }),
  );

  app.get("/api/health", async (_req, res) => {
    try {
      await sql`SELECT 1`.execute(deps.db);
      res.json({ status: "ok", database: "ok", time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: "degraded", database: "unreachable" });
    }
  });

  const api = express.Router();
  api.use(express.json({ limit: "3mb" }));
  api.use(cookieParser());
  api.use(sessionMiddleware(deps.db));
  api.use(csrfProtection);
  api.use(authRoutes(deps));
  api.use(clubRoutes(deps));
  api.use(eventRoutes(deps));
  api.use(miscRoutes(deps));
  api.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such API route." } } satisfies ApiErrorBody);
  });
  app.use("/api", api);

  const staticDir = config.STATIC_DIR ? path.resolve(config.STATIC_DIR) : null;
  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: "1h", setHeaders: (res, p) => {
      if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    let status = 500;
    let body: ApiErrorBody = { error: { code: "internal", message: "Something went wrong. Please try again." } };
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, ...err.extra } };
    } else if (isExclusionViolation(err)) {
      status = 409;
      body = { error: { code: "conflict", message: "That room was just reserved by another request for an overlapping time. Choose another time or room." } };
    } else if (isSerializationFailure(err)) {
      status = 409;
      body = { error: { code: "retry", message: "The request conflicted with a concurrent change. Please retry." } };
    } else if (err?.type === "entity.parse.failed") {
      status = 400;
      body = { error: { code: "bad_request", message: "Malformed JSON body." } };
    } else if (err?.type === "entity.too.large") {
      status = 413;
      body = { error: { code: "too_large", message: "Request body is too large." } };
    } else if (pgCode(err) === "23514" || pgCode(err) === "22P02" || pgCode(err) === "23503") {
      status = 400;
      body = { error: { code: "bad_request", message: "The request violates a data rule." } };
    }
    if (status >= 500) log.error("request failed", { method: req.method, path: req.path, err: String(err?.stack ?? err) });
    res.status(status).json(body);
  };
  app.use(onError);
  return app;
}
