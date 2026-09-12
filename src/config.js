import process from "node:process";

export const config = {
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
};

export function assertConfig() {
  if (!config.apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is missing. Put it in .env or export it in your shell.",
    );
  }
}
