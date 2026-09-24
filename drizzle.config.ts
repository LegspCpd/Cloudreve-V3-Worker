import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "";
if (!url) {
  // 允许 generate 在没有 URL 时仅做类型生成；推库脚本会强制校验
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
  verbose: true,
  strict: true,
});
