import { supakit } from "./supakit.ts";
import { z } from "./deps.ts";

// Define a simple GET route
supakit.base("/api")
  .post("/upload", {
    handler: async (req, { formData }) => {
        const file = formData.get('file');
        return { message: "Hello, world!" , file: file?.name, hello: undefined};
    },
  });

// Start the server
supakit.serve();