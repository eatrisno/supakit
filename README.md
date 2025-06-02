# supakit 🧰

A lightweight, typed `serve()` wrapper for Supabase Edge Functions with:

- ✅ Built-in CORS
- ✅ Zod-powered validation (headers, body, query, response)
- ✅ Clean handler format
- ✅ Multipart file support

## Usage

```ts
import { Supakit } from "https://deno.land/x/supakit@v1.0.0/mod.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

const bodySchema = z.object({ name: z.string() });

const api = new Supakit();
api.post("/hello", {
  bodySchema,
  handler: async (ctx) => {
    return { data: { message: `Hello, ${ctx.validatedBody.name}` } };
  },
});

api.serve();
```


```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import { Supakit } from "https://deno.land/x/supakit@v1.0.1/mod.ts";

const BodySchema = z.object({
  name: z.string(),
  age: z.number(),
});

const QuerySchema = z.object({
  error: z.string().optional(),
});

const HeadersSchema = z.object({
  'x-client-info': z.string(),
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const base = new Supakit('hello_world');
base.post('/upload', {
  headersSchema: HeadersSchema,
  querySchema: QuerySchema,
  bodySchema: BodySchema,
  handler: async (ctx) => {
    const file = ctx.formData.get('file');
    let fileName = 'no file';
    let data = null;
    let error = null;
    if (file instanceof File) {
        fileName = file.name;
        const arrayBuffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        const uploadResult = await supabase.storage
            .from('ulalo-dev')
            .upload(file.name, uint8, {
            contentType: file.type,
            upsert: true,
            });
        data = uploadResult.data;
        error = uploadResult.error;
    }
    return {
        status: 200,
        body: {
            message: 'Hello, world!',
            fileName,
            data,
            error,
            body: ctx.validatedBody,
            params: ctx.params,
            headers: ctx.validatedHeaders
        }
    };
  }
});

base.get('/get-file', {
  handler: async (ctx) => {
    const { data, error } = await supabase.storage
      .from('ulalo-dev')
      .download(ctx.params.path);

    if (error || !data) {
      return {
        status: 404,
        body: { error: error?.message || 'File not found' }
      };
    }

    // Read the file as a Uint8Array
    const fileBuffer = await data.arrayBuffer();
    const fileBytes = new Uint8Array(fileBuffer);

    // Try to get the content type from the file metadata if available
    let contentType = data.type || 'application/octet-stream';

    return new Response(fileBytes, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${ctx.params.path}"`
      }
    });
  }
});

base.serve();
```