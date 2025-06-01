import { z } from "./deps.ts";
import { supakit } from "./supakit.ts";
// Define a simple GET route
const main = supakit.base("/api")
main.use(async (req, next) => {
    if (req.headers.get("authorization") !== "Bearer 1234567890") {
      return new Response(JSON.stringify({message: "Unauthorized"}), { status: 401 });
    }
    return await next();
});

// Zod schema for validation
const BodySchema = z.object({
  file: z.instanceof(File),
  name: z.string(),
});

const test = main.group("/test")
test.post("/upload", {
    headersSchema: z.object({
        "x-client-info": z.string(),
    }),
    querySchema: z.object({
        name: z.string(),
    }),
    bodySchema: BodySchema,
    handler: async (ctx) => {
      let fileInfo: null | { name: string; size: number; type: string } = null;
      if (ctx.formData instanceof FormData) {
        const file = ctx.formData.get("file");
        if (file instanceof File) {
          fileInfo = {
            name: file.name,
            size: file.size,
            type: file.type,
          };
        }
      } else {
        console.log("No formData attached to req");
      }
      return {
        message: "Hello, world!",
        file: fileInfo,
      };
    },
});

// Start the server
supakit.serve();