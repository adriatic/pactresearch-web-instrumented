import { registerOTel } from "@vercel/otel";

// "pactresearch-web-instrumented" names this specific deployment (the
// clone this work is happening on per task 13/14's explicit workflow --
// prove here, port to production later), distinct from whatever service
// name the eventual production copy (project "pactresearch-web") will
// register under once ported. Keeps traces from the two identifiable by
// service name rather than only by project/deployment id.
export function register() {
  registerOTel({ serviceName: "pactresearch-web-instrumented" });
}
