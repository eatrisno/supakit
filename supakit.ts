import { serve as denoServe } from 'https://deno.land/std@0.177.0/http/server.ts';
import { z, ZodTypeAny } from "https://deno.land/x/zod@v3.21.4/mod.ts";

type HandlerResponse = {
  success: boolean;
  data?: any;
  error?: string;
  issues?: any[];
};

type RouteDefinition<
  TBody extends ZodTypeAny = ZodTypeAny,
  TQuery extends ZodTypeAny = ZodTypeAny,
  THeaders extends ZodTypeAny = ZodTypeAny,
  TResponse extends ZodTypeAny = ZodTypeAny
> = {
  path: string;
  methods?: string[];
  handler: HandlerFunction<TBody, TQuery, THeaders, TResponse>;
  headersSchema?: THeaders;
  bodySchema?: TBody;
  querySchema?: TQuery;
  responseSchema?: TResponse;
  middlewares?: MiddlewareFunction[];
};

type Infer<T extends ZodTypeAny | undefined> = T extends ZodTypeAny ? z.infer<T> : unknown;

type HandlerFunction<
  TBody extends ZodTypeAny = ZodTypeAny,
  TQuery extends ZodTypeAny = ZodTypeAny,
  THeaders extends ZodTypeAny = ZodTypeAny,
  TResponse extends ZodTypeAny = ZodTypeAny
> = (
  req: Request,
  extras: {
    params: Infer<TQuery> & Record<string, string>;
    headers: Infer<THeaders> & Record<string, string>;
    body?: Infer<TBody>;
    files?: { field: string, file: File }[];
    fields?: Record<string, string>;
    formData?: FormData;
  }
) => Promise<
  | Infer<TResponse>
  | {
      data?: Infer<TResponse>;
      status?: number;
      headers?: Record<string, string>;
    }
>;

// Middleware type
type MiddlewareFunction = (
  req: Request,
  extras: any,
  next: () => Promise<any>
) => Promise<any>;

// --- Fluent API ---
const routes: RouteDefinition[] = [];

function addRoute(method: string, path: string, opts: any) {
  routes.push({
    path: path.startsWith('/') ? path : '/' + path,
    methods: [method],
    ...opts,
  });
  return supakit;
}

function makeBase(basePath: string) {
  const prefix = basePath.startsWith('/') ? basePath : '/' + basePath;
  const middlewares: MiddlewareFunction[] = [];

  function withBasePath(path: string) {
    if (path === '' || path === '/') return prefix;
    return prefix + (path.startsWith('/') ? path : '/' + path);
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
    base: function(subPath: string) {
      const newBasePath = withBasePath(subPath);
      const newBase = makeBase(newBasePath);
      for (const mw of middlewares) {
        newBase.use(mw);
      }
      return newBase;
    },
    group: function(subPath: string) {
      return this.base(subPath);
    },
    get: (path: string, opts: any) => add('GET', path, opts),
    post: (path: string, opts: any) => add('POST', path, opts),
    put: (path: string, opts: any) => add('PUT', path, opts),
    delete: (path: string, opts: any) => add('DELETE', path, opts),
  };
  return baseApi;
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

export const supakit = {
  base(basePath: string) {
    return makeBase(basePath);
  },
  serve() {
    return denoServe(async (req: Request) => {
      try {
        // CORS preflight
        if (req.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const url = new URL(req.url);
        const pathname = url.pathname;
        const method = req.method;

        // Find matching route
        const route = routes.find(r => {
          if (r.path !== pathname) return false;
          if (r.methods && !r.methods.includes(method)) return false;
          return true;
        });

        if (!route) {
          return errorResponse('Not Found', 404);
        }

        // Parse query params
        let params: Record<string, string> = Object.fromEntries(url.searchParams.entries());
        if (route.querySchema) {
          const result = route.querySchema.safeParse(params);
          if (!result.success) {
            return errorResponse('Invalid query parameters', 400, result.error.issues);
          }
          params = result.data;
        }

        // Parse headers as plain object
        let headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });
        if (route.headersSchema) {
          const result = route.headersSchema.safeParse(headers);
          if (!result.success) {
            return errorResponse('Invalid headers', 400, result.error.issues);
          }
          headers = result.data;
        }

        // Parse body (JSON or multipart)
        let body: any = {};
        let formData: FormData = new FormData();

        const contentType = req.headers.get('content-type') || '';
        if (contentType.startsWith("multipart/form-data")) {
            formData = await req.formData();
        }else {
            body = await req.json();
        }

        if (route.bodySchema) {
            const result = route.bodySchema.safeParse(body);
            if (!result.success) {
              return errorResponse('Invalid request body', 400, result.error.issues);
            }
            body = result.data;
        }

        // Compose middleware and handler
        const middlewares = route.middlewares || [];
        const handler = route.handler;
        let idx = -1;
        async function dispatch(i: number): Promise<any> {
          idx = i;
          if (i < middlewares.length) {
            const result = await middlewares[i](req, { params, headers, body, formData }, () => dispatch(i + 1));
            if (result instanceof Response) return result;
            return result;
          }
          const result = await handler(req, { params, headers, body, formData });
          if (result instanceof Response) return result;
          return result;
        }
        const handlerResult = await dispatch(0);
        if (handlerResult instanceof Response) return handlerResult;
        const safeResult = replaceUndefinedWithEmpty(handlerResult);

        let status = 200;
        let resHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeaders() };
        let resBody: any = safeResult;
        if (
          safeResult &&
          typeof safeResult === 'object' &&
          ('status' in safeResult || 'body' in safeResult || 'headers' in safeResult)
        ) {
          status = safeResult.status ?? 200;
          resHeaders = { ...resHeaders, ...(safeResult.headers ?? {}) };
          resBody = 'body' in safeResult ? safeResult.body : safeResult.data ?? safeResult.body;
        }
        // Response validation
        if (route.responseSchema && resBody !== undefined) {
          const result = route.responseSchema.safeParse(resBody);
          if (!result.success) {
            return errorResponse('Invalid response data', 500, result.error.issues);
          }
          resBody = result.data;
        }
        return new Response(
          typeof resBody === 'string' ? resBody : JSON.stringify(resBody, null, 2),
          {
            status,
            headers: resHeaders,
          }
        );
      } catch (err: any) {
        return errorResponse(err?.message || 'Internal server error', 500);
      }
    });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
}

function errorResponse(message: string, status: number, issues?: any[]) {
  const errorBody: HandlerResponse = { success: false, error: message };
  if (issues) errorBody.issues = issues;
  return new Response(JSON.stringify(errorBody, null, 2), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}