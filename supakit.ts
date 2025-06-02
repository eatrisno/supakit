import { z, denoServe } from "./deps.ts";

/**
 * Version of the supakit module
 */
export const SUPAKIT_VERSION = "1.0.5";

/**
 * Handler context passed to all route handlers.
 * - formData: FormData object for multipart/form-data POST/PUT requests, or undefined
 * - validatedBody: result of bodySchema validation, or undefined
 * - validatedQuery: result of querySchema validation, or undefined
 * - validatedHeaders: result of headersSchema validation, or undefined
 * - params: path params (future-proofed), or undefined
 */
export type SupakitContext = {
  formData?: FormData;
  validatedBody?: any;
  validatedQuery?: any;
  validatedHeaders?: any;
  params?: Record<string, any>;
};

/**
 * Handler function signature for supakit routes.
 * @param ctx The context object, with formData, validatedBody, validatedQuery, validatedHeaders, and params.
 */
export type HandlerFunction = (ctx: SupakitContext) => Promise<any>;

/**
 * Middleware function signature for supakit.
 */
export type MiddlewareFunction = (req: Request, next: () => Promise<any>) => Promise<any>;

/**
 * Route definition for supakit's internal registry.
 */
type RouteDefinition = {
  path: string;
  methods?: string[];
  handler: HandlerFunction;
  headersSchema?: z.ZodTypeAny;
  bodySchema?: z.ZodTypeAny;
  querySchema?: z.ZodTypeAny;
  responseSchema?: z.ZodTypeAny;
  middlewares?: MiddlewareFunction[];
};

export class Supakit {
  static version = "1.0.5";
  private basePath: string;
  private routes: RouteDefinition[] = [];
  private middlewares: MiddlewareFunction[] = [];
  private parent?: Supakit;

  constructor(basePath: string = "", parent?: Supakit) {
    this.basePath = basePath.startsWith("/") ? basePath : basePath ? "/" + basePath : "";
    this.parent = parent;
  }

  private getRoot(): Supakit {
    return this.parent ? this.parent.getRoot() : this;
  }

  private getFullPath(path: string): string {
    const base = this.basePath;
    if (path === "" || path === "/") return base;
    return base + (path.startsWith("/") ? path : "/" + path);
  }

  use(mw: MiddlewareFunction) {
    this.middlewares.push(mw);
    return this;
  }

  base(subPath: string) {
    // Return a proxy that registers on the root, but with extended path and middleware
    const newBasePath = this.getFullPath(subPath);
    const parent = this.getRoot();
    const inheritedMiddlewares = [...this.middlewares];
    const proxy = {
      use: (mw: MiddlewareFunction) => {
        inheritedMiddlewares.push(mw);
        return proxy;
      },
      base: (sub: string) => proxy.group(sub),
      group: (sub: string) => {
        const subBasePath = newBasePath + (sub.startsWith("/") ? sub : "/" + sub);
        // Recursively create a new proxy for deeper nesting
        return parent._makeProxy(subBasePath, [...inheritedMiddlewares]);
      },
      get: (path: string, opts: any) => parent._addWithProxy("GET", newBasePath, path, opts, inheritedMiddlewares),
      post: (path: string, opts: any) => parent._addWithProxy("POST", newBasePath, path, opts, inheritedMiddlewares),
      put: (path: string, opts: any) => parent._addWithProxy("PUT", newBasePath, path, opts, inheritedMiddlewares),
      delete: (path: string, opts: any) => parent._addWithProxy("DELETE", newBasePath, path, opts, inheritedMiddlewares),
    };
    return proxy;
  }

  group(subPath: string) {
    return this.base(subPath);
  }

  private _makeProxy(basePath: string, middlewares: MiddlewareFunction[]) {
    const parent = this.getRoot();
    const proxy = {
      use: (mw: MiddlewareFunction) => {
        middlewares.push(mw);
        return proxy;
      },
      base: (sub: string) => proxy.group(sub),
      group: (sub: string) => {
        const subBasePath = basePath + (sub.startsWith("/") ? sub : "/" + sub);
        return parent._makeProxy(subBasePath, [...middlewares]);
      },
      get: (path: string, opts: any) => parent._addWithProxy("GET", basePath, path, opts, middlewares),
      post: (path: string, opts: any) => parent._addWithProxy("POST", basePath, path, opts, middlewares),
      put: (path: string, opts: any) => parent._addWithProxy("PUT", basePath, path, opts, middlewares),
      delete: (path: string, opts: any) => parent._addWithProxy("DELETE", basePath, path, opts, middlewares),
    };
    return proxy;
  }

  private _addWithProxy(method: string, basePath: string, path: string, opts: any, middlewares: MiddlewareFunction[]) {
    const fullPath = basePath + (path.startsWith("/") ? path : "/" + path);
    const routeDef = typeof opts === "function" ? { handler: opts } : opts;
    this.getRoot().routes.push({
      path: fullPath,
      methods: [method],
      ...routeDef,
      middlewares: [...(routeDef.middlewares || []), ...middlewares],
    });
    return this;
  }

  get(path: string, opts: any) {
    return this._addWithProxy("GET", this.basePath, path, opts, this.middlewares);
  }
  post(path: string, opts: any) {
    return this._addWithProxy("POST", this.basePath, path, opts, this.middlewares);
  }
  put(path: string, opts: any) {
    return this._addWithProxy("PUT", this.basePath, path, opts, this.middlewares);
  }
  delete(path: string, opts: any) {
    return this._addWithProxy("DELETE", this.basePath, path, opts, this.middlewares);
  }

  serve() {
    const routes = this.getRoot().routes;
    return denoServe(async (req: Request) => {
      try {
        const corsResponse = handleCors(req);
        if (corsResponse) return corsResponse;

        const url = new URL(req.url);
        const pathname = url.pathname;
        const method = req.method;

        const route = routes.find((r) => {
          if (r.path !== pathname) return false;
          if (r.methods && !r.methods.includes(method)) return false;
          return true;
        });

        if (!route) {
          return errorResponse("Not Found", 404);
        }

        const middlewares = route.middlewares || [];
        const handler = route.handler;
        let idx = -1;
        async function dispatch(i: number): Promise<any> {
          idx = i;
          if (i < middlewares.length) {
            const result = await middlewares[i](req, () => dispatch(i + 1));
            if (result instanceof Response) return result;
            return result;
          }

          if (!route) return errorResponse("Not Found", 404);

          let formData: FormData | undefined = await parseFormData(req);
          let validatedQuery, validatedHeaders, validatedBody;
          try {
            ({ validatedQuery, validatedHeaders, validatedBody, formData } = await validateRequest(
              req,
              {
                querySchema: route.querySchema,
                headersSchema: route.headersSchema,
                bodySchema: route.bodySchema,
              },
              formData
            ));
          } catch (e) {
            if (e.type === "query") return errorResponse("Invalid query", 400, e.issues);
            if (e.type === "headers") return errorResponse("Invalid headers", 400, e.issues);
            if (e.type === "body") return errorResponse("Invalid body", 400, e.issues);
            throw e;
          }
          const ctx: SupakitContext = {
            formData,
            validatedBody,
            validatedQuery,
            validatedHeaders,
            params: {},
          };
          const result = await handler(ctx);
          if (result instanceof Response) return result;
          return result;
        }
        const handlerResult = await dispatch(0);
        if (handlerResult instanceof Response) return handlerResult;
        const safeResult = replaceUndefinedWithEmpty(handlerResult);

        let status = 200;
        let resHeaders: Record<string, string> = { "Content-Type": "application/json", ...corsHeaders() };
        let resBody: any = safeResult;
        if (
          safeResult &&
          typeof safeResult === "object" &&
          ("status" in safeResult || "body" in safeResult || "headers" in safeResult)
        ) {
          status = safeResult.status ?? 200;
          resHeaders = { ...resHeaders, ...(safeResult.headers ?? {}) };
          resBody = "body" in safeResult ? safeResult.body : safeResult.data ?? safeResult.body;
        }
        if (route.responseSchema && resBody !== undefined) {
          const result = route.responseSchema.safeParse(resBody);
          if (!result.success) {
            return errorResponse("Invalid response data", 500, result.error.issues);
          }
          resBody = result.data;
        }
        return new Response(
          typeof resBody === "string" ? resBody : JSON.stringify(resBody, null, 2),
          {
            status,
            headers: resHeaders,
          }
        );
      } catch (err: any) {
        return errorResponse(err?.message || "Internal server error", 500);
      }
    });
  }

  static getFormFileName(formData: FormData | undefined, field: string): string | null {
    if (!formData) return null;
    const file = formData.get(field);
    return file instanceof File ? file.name : null;
  }
}

/**
 * Utility to parse and validate query parameters.
 */
function parseAndValidateQuery(req: Request, schema?: z.ZodTypeAny) {
  if (!schema) return undefined;
  const urlObj = new URL(req.url);
  const queryObj: Record<string, string> = {};
  for (const [k, v] of urlObj.searchParams.entries()) {
    queryObj[k] = v;
  }
  const result = schema.safeParse(queryObj);
  if (!result.success) {
    throw { type: "query", issues: result.error.issues };
  }
  return result.data;
}

/**
 * Utility to parse and validate headers.
 */
function parseAndValidateHeaders(req: Request, schema?: z.ZodTypeAny) {
  if (!schema) return undefined;
  const headersObj: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) {
    headersObj[k.toLowerCase()] = v;
  }
  const result = schema.safeParse(headersObj);
  if (!result.success) {
    throw { type: "headers", issues: result.error.issues };
  }
  return result.data;
}

/**
 * Utility to parse and validate the body.
 * Also attaches formData if multipart.
 */
async function parseAndValidateBody(req: Request, schema?: z.ZodTypeAny, formData?: FormData) {
  if (!schema) return { body: undefined, formData };
  const contentType = req.headers.get("content-type") || "";
  let bodyData: any = undefined;
  let usedFormData: FormData | undefined = formData;
  if (contentType.includes("application/json")) {
    try {
      bodyData = await req.json();
    } catch {
      throw { type: "body", issues: [{ message: "Malformed JSON" }] };
    }
  } else if (contentType.includes("multipart/form-data")) {
    try {
      if (!usedFormData) {
        usedFormData = await req.formData();
      }
      bodyData = {};
      for (const [key, value] of usedFormData.entries()) {
        bodyData[key] = value;
      }
    } catch (e) {
      throw { type: "body", issues: [{ message: e.message || "Malformed multipart form-data" }] };
    }
  }
  const result = schema.safeParse(bodyData);
  if (!result.success) {
    throw { type: "body", issues: result.error.issues };
  }
  return { body: result.data, formData: usedFormData };
}

/**
 * Utility to always parse formData if content-type is multipart/form-data.
 */
async function parseFormData(req: Request): Promise<FormData | undefined> {
  const contentType = req.headers.get("content-type") || "";
  if (
    (req.method === "POST" || req.method === "PUT") &&
    contentType.includes("multipart/form-data")
  ) {
    try {
      return await req.formData();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Validate query, headers, and body using Zod schemas.
 * Returns { validatedQuery, validatedHeaders, validatedBody, formData }
 * Throws on validation error.
 */
async function validateRequest(
  req: Request,
  schemas: {
    querySchema?: z.ZodTypeAny;
    headersSchema?: z.ZodTypeAny;
    bodySchema?: z.ZodTypeAny;
  },
  formData?: FormData
) {
  let validatedQuery, validatedHeaders, validatedBody;
  try {
    validatedQuery = parseAndValidateQuery(req, schemas.querySchema);
  } catch (e) {
    if (e.type === "query") throw { type: "query", issues: e.issues };
    throw e;
  }
  try {
    validatedHeaders = parseAndValidateHeaders(req, schemas.headersSchema);
  } catch (e) {
    if (e.type === "headers") throw { type: "headers", issues: e.issues };
    throw e;
  }
  try {
    const bodyResult = await parseAndValidateBody(req, schemas.bodySchema, formData);
    validatedBody = bodyResult.body;
    if (bodyResult.formData) formData = bodyResult.formData;
  } catch (e) {
    if (e.type === "body") throw { type: "body", issues: e.issues };
    throw e;
  }
  return { validatedQuery, validatedHeaders, validatedBody, formData };
}

function replaceUndefinedWithEmpty(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(replaceUndefinedWithEmpty);
  } else if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, v === undefined ? "" : replaceUndefinedWithEmpty(v)])
    );
  }
  return obj;
}

/**
 * Handle CORS preflight and headers.
 */
function handleCors(req: Request): Response | undefined {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  return undefined;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
}

function errorResponse(message: string, status: number, issues?: any[]) {
  const errorBody = { success: false, error: message } as Record<string, any>;
  if (issues) errorBody.issues = issues;
  return new Response(JSON.stringify(errorBody, null, 2), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}