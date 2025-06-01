import { serve as denoServe } from 'https://deno.land/std@0.177.0/http/server.ts';
import { z, ZodSchema, ZodTypeAny } from "https://deno.land/x/zod@v3.21.4/mod.ts";

// Helper for multipart parsing
async function parseMultipartFormData(req: Request) {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.startsWith('multipart/form-data')) return null;
  const formData = await req.formData();
  const fields: Record<string, string> = {};
  const files: Record<string, File[]> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
    } else if (value instanceof File) {
      if (!files[key]) files[key] = [];
      files[key].push(value);
    }
  }
  return { fields, files };
}

type HandlerResponse = {
  success: boolean;
  data?: any;
  error?: string;
  issues?: any[];
};

type ServeOptions<
  TBody extends ZodTypeAny = ZodTypeAny,
  TQuery extends ZodTypeAny = ZodTypeAny,
  THeaders extends ZodTypeAny = ZodTypeAny,
  TResponse extends ZodTypeAny = ZodTypeAny
> = {
  methods?: string[];
  requireParams?: string[];
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
    files?: Record<string, File[]>;
    fields?: Record<string, string>;
  }
) => Promise<
  | Infer<TResponse>
  | {
      data?: Infer<TResponse>;
      status?: number;
      headers?: Record<string, string>;
    }
>;

export function serve<
  TBody extends ZodTypeAny = ZodTypeAny,
  TQuery extends ZodTypeAny = ZodTypeAny,
  THeaders extends ZodTypeAny = ZodTypeAny,
  TResponse extends ZodTypeAny = ZodTypeAny
>(
  handler: HandlerFunction<TBody, TQuery, THeaders, TResponse>,
  options: ServeOptions<TBody, TQuery, THeaders, TResponse> = {}
) {
  return denoServe(async (req: Request) => {
    try {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // Method restriction
      if (options.methods && !options.methods.includes(req.method)) {
        return errorResponse('Method Not Allowed', 405);
      }

      // Parse query params
      const url = new URL(req.url);
      let params: Record<string, string> = Object.fromEntries(url.searchParams.entries());

      // Query param validation
      if (options.querySchema) {
        const result = options.querySchema.safeParse(params);
        if (!result.success) {
          return errorResponse('Invalid query parameters', 400, result.error.issues);
        }
        params = result.data;
      } else if (options.requireParams) {
        for (const param of options.requireParams) {
          if (!(param in params)) {
            return errorResponse(`Missing required query parameter: ${param}`, 400);
          }
        }
      }

      // Parse headers as plain object
      let headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      // Headers schema validation
      if (options.headersSchema) {
        const result = options.headersSchema.safeParse(headers);
        if (!result.success) {
          return errorResponse('Invalid headers', 400, result.error.issues);
        }
        headers = result.data;
      }

      // Parse body (JSON or multipart)
      let body: any = undefined;
      let files: Record<string, File[]> | undefined = undefined;
      let fields: Record<string, string> | undefined = undefined;
      const contentType = req.headers.get('content-type') || '';
      if (contentType.startsWith('multipart/form-data')) {
        const parsed = await parseMultipartFormData(req);
        if (parsed) {
          files = parsed.files;
          fields = parsed.fields;
        }
      } else if (options.bodySchema) {
        // Always try to parse JSON if bodySchema is present
        try {
          body = await req.json();
        } catch {
          return errorResponse('Invalid or missing JSON body', 400);
        }
        // Zod body schema validation
        const result = options.bodySchema.safeParse(body);
        if (!result.success) {
          return errorResponse('Invalid request body', 400, result.error.issues);
        }
        body = result.data;
      }

      // Call handler
      const handlerResult = await handler(req, { params, headers, body, files, fields });

      // Support custom status and headers from handler
      let data: any = handlerResult;
      let status = 200;
      let customHeaders: Record<string, string> = {};
      if (
        handlerResult &&
        typeof handlerResult === 'object' &&
        ('data' in handlerResult || 'status' in handlerResult || 'headers' in handlerResult)
      ) {
        data = handlerResult.data;
        status = handlerResult.status ?? 200;
        customHeaders = handlerResult.headers ?? {};
      }

      // Response validation
      if (options.responseSchema && data !== undefined) {
        const result = options.responseSchema.safeParse(data);
        if (!result.success) {
          return errorResponse('Invalid response data', 500, result.error.issues);
        }
        data = result.data;
      }

      return new Response(
        JSON.stringify({ success: true, data }, null, 2),
        {
          status,
          headers: { ...corsHeaders(), ...customHeaders, 'Content-Type': 'application/json' },
        }
      );
    } catch (err: any) {
      return errorResponse(err?.message || 'Internal server error', 500);
    }
  });
}

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