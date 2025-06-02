import { z } from "./deps.ts";
import { Supakit } from "./supakit.ts";
// Define a simple POST route directly
const main = new Supakit();
main.use(async (req, next) => {
    console.log("[Middleware] Authorization check, not reading body");
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
main.post("/test/sample",{
  handler: async (req) => {
    const data = req.headers.get("x-client-info");
    console.log(data);
    return {
      message: "Hello, world!",
    };
  },
})
main.post("/test/uploads", {
    handler: async (req) => {
      console.log("[Handler] About to call req.formData()");
      let fileInfo: null | { name: string; size: number; type: string } = null;
      if (req.headers.get("content-type")?.includes("multipart/form-data")) {
        const formData = await req.formData();
        const file = formData.get("file");
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
main.serve();