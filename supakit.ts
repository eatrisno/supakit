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

const routes: RouteDefinition[] = [];

function addRoute(method: string, path: string, opts: any) {
  // Support both direct function and object with handler
  const routeDef = typeof opts === "function" ? { handler: opts } : opts;
  routes.push({
    path: path.startsWith("/") ? path : "/" + path,
    methods: [method],
    ...routeDef,
  });
  return supakit;
}

function makeBase(basePath: string) {
  const prefix = basePath.startsWith("/") ? basePath : "/" + basePath;
  const middlewares: MiddlewareFunction[] = [];

  function withBasePath(path: string) {
    if (path === "" || path === "/") return prefix;
    return prefix + (path.startsWith("/") ? path : "/" + path);
  }

  function use(mw: MiddlewareFunction) {
    middlewares.push(mw);
    return baseApi;
  }

  function add(method: string, path: string, opts: any) {
    addRoute(method, withBasePath(path), { ...opts, middlewares: [...middlewares] });
    return baseApi;
  }

  const baseApi = {
    use,
    base: function (subPath: string) {
      const newBasePath = withBasePath(subPath);
      const newBase = makeBase(newBasePath);
      for (const mw of middlewares) {
        newBase.use(mw);
      }
      return newBase;
    },
    group: function (subPath: string) {
      return this.base(subPath);
    },
    get: (path: string, opts: any) => add("GET", path, opts),
    post: (path: string, opts: any) => add("POST", path, opts),
    put: (path: string, opts: any) => add("PUT", path, opts),
    delete: (path: string, opts: any) => add("DELETE", path, opts),
  };
  return baseApi;
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
async function attachFormDataIfNeeded(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      return await req.formData();
    } catch {
      return undefined;
    }
  }
  return undefined;
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
 * Utility to safely get a file name from a FormData field.
 * @param formData The FormData object
 * @param field The field name
 * @returns The file name if the field is a File, otherwise null
 */
function getFormFileName(formData: FormData | undefined, field: string): string | null {
  if (!formData) return null;
  const file = formData.get(field);
  return file instanceof File ? file.name : null;
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

/**
 * Parse formData once for multipart/form-data POST/PUT requests.
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

export const supakit = {
  version: SUPAKIT_VERSION,
  base(basePath: string) {
    return makeBase(basePath);
  },
  serve() {
    return denoServe(async (req: Request) => {
      try {
        // CORS preflight
        const corsResponse = handleCors(req);
        if (corsResponse) return corsResponse;

        const url = new URL(req.url);
        const pathname = url.pathname;
        const method = req.method;

        // Find matching route
        const route = routes.find((r) => {
          if (r.path !== pathname) return false;
          if (r.methods && !r.methods.includes(method)) return false;
          return true;
        });

        if (!route) {
          return errorResponse("Not Found", 404);
        }

        // Compose middleware and handler
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

          // Ensure route is defined before proceeding
          if (!route) return errorResponse("Not Found", 404);

          // Parse formData once
          let formData: FormData | undefined = await parseFormData(req);
          // Validate and get all validated data
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
          // Build the context object for the handler
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
        // Response validation
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
  },
  getFormFileName,
};

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