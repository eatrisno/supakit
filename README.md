# supakit 🧰

A lightweight, typed `serve()` wrapper for Supabase Edge Functions with:

- ✅ Built-in CORS
- ✅ Zod-powered validation (headers, body, query, response)
- ✅ Clean handler format
- ✅ Multipart file support

## Usage

```ts
import { serve } from "https://deno.land/x/supakit@v1.0.0/mod.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

const bodySchema = z.object({ name: z.string() });

serve(async (req, { body }) => {
  return { data: { message: `Hello, ${body.name}` } };
}, {
  methods: ['POST'],
  bodySchema,
});