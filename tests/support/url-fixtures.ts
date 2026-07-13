interface UrlCredentials {
  readonly username: string;
  readonly password: string;
}

export function buildCredentialedUrl(baseUrl: string, credentials: UrlCredentials): string {
  const url = new URL(baseUrl);
  url.username = credentials.username;
  url.password = credentials.password;
  return url.href;
}
