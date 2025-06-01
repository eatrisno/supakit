import { serve as denoServe } from 'https://deno.land/std@0.177.0/http/server.ts';
import { z, ZodSchema, ZodTypeAny } from "https://deno.land/x/zod@v3.21.4/mod.ts";

// Helper for multipart parsing
async function parseMultipartFormData(req: Request) {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.startsWith('multipart/form-data')) return null;
  const formData = await req.formData();
  const fields: Record<string, string> = {};
  const files: { field: string, file: File }[] = [];
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
    } else if (value instanceof File) {
      files.push({ field: key, file: value });
    }
  }
  return { fields, files, formData };
}

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
  function withBasePath(path: string) {
    if (path === '' || path === '/') return prefix;
    return prefix + (path.startsWith('/') ? path : '/' + path);
  }
  return {
    get(path: string, opts: any) {
      addRoute('GET', withBasePath(path), opts);
      return this;
    },
    post(path: string, opts: any) {
      addRoute('POST', withBasePath(path), opts);
      return this;
    },
    put(path: string, opts: any) {
      addRoute('PUT', withBasePath(path), opts);
      return this;
    },
    delete(path: string, opts: any) {
      addRoute('DELETE', withBasePath(path), opts);
      return this;
    },
  };
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
        let body: any = undefined;
        let files: { field: string, file: File }[] | undefined = undefined;
        let fields: Record<string, string> | undefined = undefined;
        let formData: FormData | undefined = undefined;
        const contentType = req.headers.get('content-type') || '';
        if (contentType.startsWith('multipart/form-data')) {
          const parsed = await parseMultipartFormData(req);
          if (parsed) {
            files = parsed.files;
            fields = parsed.fields;
            formData = parsed.formData;
          }
        } else if (route.bodySchema) {
          try {
            body = await req.json();
          } catch {
            return errorResponse('Invalid or missing JSON body', 400);
          }
          const result = route.bodySchema.safeParse(body);
          if (!result.success) {
            return errorResponse('Invalid request body', 400, result.error.issues);
          }
          body = result.data;
        }

        // Call handler
        const handlerResult = await route.handler(req, { params, headers, body, files, fields, formData });

        // Hono-like response handling
        if (handlerResult instanceof Response) {
          return handlerResult;
        }
        let status = 200;
        let resHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeaders() };
        let resBody: any = handlerResult;
        if (
          handlerResult &&
          typeof handlerResult === 'object' &&
          ('status' in handlerResult || 'body' in handlerResult || 'headers' in handlerResult)
        ) {
          status = handlerResult.status ?? 200;
          resHeaders = { ...resHeaders, ...(handlerResult.headers ?? {}) };
          resBody = 'body' in handlerResult ? handlerResult.body : handlerResult.data ?? handlerResult.body;
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