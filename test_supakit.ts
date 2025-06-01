import { supakit } from "./supakit.ts";
import { z } from "./deps.ts";

// Define a simple GET route
const base = supakit.base("/api")
base.use(async (req, { headers }, next) => {
    if (headers["authorization"] !== "Bearer 1234567890") {
      return new Response(JSON.stringify({ headers: headers, message: "Unauthorized"}), { status: 401 });
    }
    return await next();
  });

base.post("/upload", {
    handler: async (req, { formData }) => {
        const file = formData.get('file');
        // return { message: "Hello, world!" , file: file?.name, hello: undefined};
        return new Response(JSON.stringify({ file: file?.name, message: "Hello, world!"}), { status: 200 });
    },
  });

// Start the server
supakit.serve();