/** Logged URLs never carry secrets: drop query strings (webhook token) and mask applicant link tokens. */
export function redactUrl(url: string): string {
  return url.split("?")[0]!.replace(/^\/(i|api\/applicant)\/[^/]+/, "/$1/[link]");
}
