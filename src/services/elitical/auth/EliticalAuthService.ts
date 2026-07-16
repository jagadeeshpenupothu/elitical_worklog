import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from "playwright";
import type {
  EliticalAuthenticatedRequest,
  EliticalAuthenticatedResponse,
  EliticalAuthServiceContract,
  EliticalConfig,
  EliticalConfigInput,
  EliticalSession,
} from "../types";
import { EliticalAuthError } from "./EliticalAuthError";
import { resolveEliticalConfig } from "./EliticalConfig";

type VerificationPayload = {
  employeeId?: string;
  empId?: string;
  projectId?: string;
  token?: string;
  authorization?: string;
  sJwtToken?: string;
  sJWTToken?: string;
  sessionId?: string;
};

type StorageStateDiagnostic = {
  cookies?: Array<{
    name?: string;
    domain?: string;
  }>;
  origins?: unknown[];
};

type VerificationFetchResult = {
  ok: boolean;
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: string;
  error?: string;
};

const browserIds = new WeakMap<Browser, number>();
const contextIds = new WeakMap<BrowserContext, number>();
const pageIds = new WeakMap<Page, number>();
let nextBrowserId = 1;
let nextContextId = 1;
let nextPageId = 1;
let nextAuthServiceId = 1;

function browserTypeFor(config: EliticalConfig): BrowserType {
  if (config.browserType === "firefox") return firefox;
  if (config.browserType === "webkit") return webkit;
  return chromium;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function storageStateExists(storageStatePath: string) {
  return access(storageStatePath)
    .then(() => true)
    .catch(() => false);
}

async function readStorageStateDiagnostic(storageStatePath: string) {
  try {
    const raw = await readFile(storageStatePath, "utf8");

    return JSON.parse(raw) as StorageStateDiagnostic;
  } catch (error) {
    console.info("[EliticalAuthService] Unable to read storageState JSON.", {
      error: error instanceof Error ? error.message : String(error),
    });

    return null;
  }
}

function logCookieDiagnostic(
  label: string,
  cookies: Array<{ name?: string; domain?: string }>
) {
  const firstCookie = cookies[0];

  console.info(`[EliticalAuthService] ${label}`, {
    cookieCount: cookies.length,
    firstCookieName: firstCookie?.name || "",
    firstCookieDomain: firstCookie?.domain || "",
  });
}

function browserInstanceId(browser: Browser | null): string {
  if (!browser) return "none";
  if (!browserIds.has(browser)) browserIds.set(browser, nextBrowserId++);
  return String(browserIds.get(browser));
}

function contextInstanceId(context: BrowserContext | null): string {
  if (!context) return "none";
  if (!contextIds.has(context)) contextIds.set(context, nextContextId++);
  return String(contextIds.get(context));
}

function pageInstanceId(page: Page | null): string {
  if (!page) return "none";
  if (!pageIds.has(page)) pageIds.set(page, nextPageId++);
  return String(pageIds.get(page));
}

function logRuntimeInstances(
  label: string,
  authServiceId: number,
  browser: Browser | null,
  context: BrowserContext | null,
  page: Page | null
) {
  console.info(`[EliticalAuthService] ${label}`, {
    authServiceInstanceId: authServiceId,
    browserInstanceId: browserInstanceId(browser),
    browserContextInstanceId: contextInstanceId(context),
    pageInstanceId: pageInstanceId(page),
  });
}

function summarizeStorage(storage: Record<string, string>) {
  return {
    keyCount: Object.keys(storage).length,
    hasAuthorization: Boolean(storage["flutter.authorization"]),
    hasSJwtToken: Boolean(storage["flutter.s-jwt-token"]),
    hasPassword: Boolean(storage["flutter.password"]),
  };
}

function verificationUrl(config: EliticalConfig) {
  const url = new URL(config.verificationPath, `${config.baseUrl}/`);

  if (!url.searchParams.has("utResCode")) {
    url.searchParams.set("utResCode", "200");
  }

  return url.toString();
}

function requestUrl(config: EliticalConfig, request: EliticalAuthenticatedRequest) {
  const url = new URL(request.path, `${config.baseUrl}/`);

  Object.entries(request.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  if (!url.searchParams.has("utResCode")) {
    url.searchParams.set("utResCode", "200");
  }

  return url.toString();
}

function payloadToSession(payload: VerificationPayload): EliticalSession {
  return {
    token: String(payload.token || ""),
    authorization: String(payload.authorization || ""),
    sJwtToken: String(payload.sJwtToken || payload.sJWTToken || ""),
    sessionId: String(payload.sessionId || ""),
    employeeId: String(payload.employeeId || payload.empId || ""),
    projectId: String(payload.projectId || ""),
    authenticatedAt: new Date().toISOString(),
  };
}

export class EliticalAuthService implements EliticalAuthServiceContract {
  readonly config: EliticalConfig;
  private readonly instanceId = nextAuthServiceId++;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(config: EliticalConfigInput = {}) {
    this.config = resolveEliticalConfig(config);
    console.info("[EliticalAuthService] constructed", {
      authServiceInstanceId: this.instanceId,
    });
  }

  async initialize(): Promise<void> {
    console.info("[EliticalAuthService] initialize() called", {
      authServiceInstanceId: this.instanceId,
    });

    try {
      await mkdir(path.dirname(this.config.storageStatePath), {
        recursive: true,
      });

      if (await storageStateExists(this.config.storageStatePath)) {
        await this.restoreSession();
      }
    } catch (error) {
      if (error instanceof EliticalAuthError) throw error;

      throw new EliticalAuthError(
        "INITIALIZATION_FAILED",
        "Unable to initialize Elitical authentication.",
        { cause: error }
      );
    }
  }

  async login(): Promise<EliticalSession | null> {
    console.info("[EliticalAuthService] login() called", {
      authServiceInstanceId: this.instanceId,
    });

    try {
      await this.closeRuntime();

      const context = await this.createContext();
      const page = await this.ensurePage(context);

      await page.goto(this.config.baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.loginTimeoutMs,
      });

      const session = await this.waitForAuthenticatedSession(page);
      await this.persistSession(context);
      this.context = context;

      return session;
    } catch (error) {
      if (error instanceof EliticalAuthError) throw error;

      await this.closeRuntime();

      throw new EliticalAuthError(
        "LOGIN_FAILED",
        "Unable to complete Elitical login.",
        { cause: error }
      );
    }
  }

  async logout(): Promise<void> {
    try {
      await this.closeRuntime();
      await rm(this.config.storageStatePath, {
        force: true,
      });
    } catch (error) {
      throw new EliticalAuthError(
        "LOGOUT_FAILED",
        "Unable to clear Elitical session.",
        { cause: error }
      );
    }
  }

  async restoreSession(): Promise<EliticalSession | null> {
    console.info("[EliticalAuthService] restoreSession() called", {
      authServiceInstanceId: this.instanceId,
      callStack: new Error().stack,
    });

    if (!(await storageStateExists(this.config.storageStatePath))) {
      return null;
    }

    try {
      if (this.context && this.page) {
        logRuntimeInstances(
          "restoreSession reusing existing runtime",
          this.instanceId,
          this.browser,
          this.context,
          this.page
        );

        return this.verifySession(this.page);
      }

      const context = await this.createContext({
        storageState: this.config.storageStatePath,
      });
      const page = await this.ensurePage(context);
      const session = await this.verifySession(page);

      if (!session) {
        logRuntimeInstances(
          "restoreSession verification returned unauthenticated; closing runtime",
          this.instanceId,
          this.browser,
          context,
          page
        );
        await this.closeRuntime();
        return null;
      }

      this.context = context;
      this.page = page;
      return session;
    } catch (error) {
      await this.closeRuntime();

      throw new EliticalAuthError(
        "SESSION_RESTORE_FAILED",
        "Unable to restore Elitical session.",
        { cause: error }
      );
    }
  }

  async hasValidSession(): Promise<boolean> {
    if (!(await storageStateExists(this.config.storageStatePath))) {
      return false;
    }

    try {
      const session = await this.restoreSession();

      if (!session || !this.context || !this.page) {
        return false;
      }

      return Boolean(session);
    } catch (error) {
      if (error instanceof EliticalAuthError) {
        if (error.code === "SESSION_INVALID") return false;
      }

      throw new EliticalAuthError(
        "SESSION_RESTORE_FAILED",
        "Unable to validate Elitical session.",
        { cause: error }
      );
    }
  }

  async authenticatedRequest(
    request: EliticalAuthenticatedRequest
  ): Promise<EliticalAuthenticatedResponse> {
    console.info("[EliticalAuthService] authenticatedRequest() called", {
      authServiceInstanceId: this.instanceId,
      path: request.path,
      method: request.method || "GET",
      callStack: new Error().stack,
    });

    const previousRequest = this.requestQueue;
    let releaseRequest: () => void = () => {};

    this.requestQueue = new Promise((resolve) => {
      releaseRequest = resolve;
    });

    await previousRequest.catch(() => undefined);

    try {
      const response = await this.sendAuthenticatedRequest(request);

      if (response.status !== 401) {
        return response;
      }

      console.info("[EliticalAuthService] authenticatedRequest renewing session after 401", {
        authServiceInstanceId: this.instanceId,
        path: request.path,
        method: request.method || "GET",
      });

      await this.login();

      return this.sendAuthenticatedRequest(request);
    } finally {
      releaseRequest();
    }
  }

  private async sendAuthenticatedRequest(
    request: EliticalAuthenticatedRequest
  ): Promise<EliticalAuthenticatedResponse> {
    const context = await this.ensureAuthenticatedContext();
    const page = await this.ensurePage(context);
    const endpoint = requestUrl(this.config, request);
    const referrer = request.referrerPath
      ? new URL(request.referrerPath, `${this.config.baseUrl}/`).toString()
      : undefined;

    try {
      logRuntimeInstances(
        "authenticatedRequest runtime",
        this.instanceId,
        this.browser,
        context,
        page
      );

      const response = await page.evaluate(
        async ({ endpoint: targetEndpoint, method, body, referrer: requestReferrer, timeoutMs }) => {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

          try {
            const headers: Record<string, string> = {
              Accept: "application/json",
              "Content-Type": "application/json",
            };
            let authorization = window.localStorage.getItem("flutter.authorization");
            let sJwtToken = window.localStorage.getItem("flutter.s-jwt-token");

            try {
              const parsedAuthorization = JSON.parse(authorization || "");
              if (typeof parsedAuthorization === "string") {
                authorization = parsedAuthorization;
              }
            } catch {
              // Keep the raw localStorage value when it is not JSON encoded.
            }

            try {
              const parsedSJwtToken = JSON.parse(sJwtToken || "");
              if (typeof parsedSJwtToken === "string") {
                sJwtToken = parsedSJwtToken;
              }
            } catch {
              // Keep the raw localStorage value when it is not JSON encoded.
            }

            if (authorization) headers.authorization = authorization;
            if (sJwtToken) headers["s-jwt-token"] = sJwtToken;

            const fetchOptions: RequestInit = {
              method,
              headers,
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: controller.signal,
            };

            if (requestReferrer) {
              fetchOptions.referrer = requestReferrer;
            }

            const response = await window.fetch(targetEndpoint, fetchOptions);
            const responseHeaders = Object.fromEntries(response.headers.entries());
            const refreshedAuthorization = responseHeaders.authorization;

            if (refreshedAuthorization) {
              window.localStorage.setItem(
                "flutter.authorization",
                refreshedAuthorization
              );
            }

            const text = await response.text();
            let payload: unknown = null;

            if (text) {
              try {
                payload = JSON.parse(text);
              } catch {
                payload = text;
              }
            }

            return {
              endpoint: targetEndpoint,
              ok: response.ok,
              status: response.status,
              statusText: response.statusText,
              payload,
              headers: responseHeaders,
            };
          } finally {
            window.clearTimeout(timeout);
          }
        },
        {
          endpoint,
          method: request.method || "GET",
          body: request.body,
          referrer,
          timeoutMs: request.timeoutMs || this.config.verificationTimeoutMs,
        }
      );

      const responseHeaders = (
        response as EliticalAuthenticatedResponse & {
          headers?: Record<string, string>;
        }
      ).headers;
      const refreshedAuthorization = Boolean(responseHeaders?.authorization);
      const refreshedSJwtToken = Boolean(responseHeaders?.["s-jwt-token"]);

      console.info("[EliticalAuthService] authenticatedRequest response", {
        endpoint,
        method: request.method || "GET",
        referrer: referrer || "",
        httpStatus: response.status,
        ok: response.ok,
        refreshedAuthorization,
        refreshedSJwtToken,
      });

      if (response.ok && refreshedAuthorization) {
        await this.persistSession(context);
      }

      if (response.status === 401) {
        console.error("[EliticalAuthService] authenticatedRequest 401", {
          authServiceInstanceId: this.instanceId,
          endpoint,
          method: request.method || "GET",
          referrer: referrer || "",
          callStack: new Error().stack,
        });
      }

      return response;
    } finally {
      logRuntimeInstances(
        "authenticatedRequest complete",
        this.instanceId,
        this.browser,
        context,
        page
      );
    }
  }

  private async ensureAuthenticatedContext() {
    if (this.context) return this.context;

    const session = await this.restoreSession();

    if (!session || !this.context) {
      throw new EliticalAuthError(
        "SESSION_INVALID",
        "Elitical authentication is required."
      );
    }

    return this.context;
  }

  private async createContext(options: { storageState?: string } = {}) {
    if (this.context) {
      logRuntimeInstances(
        "browser.newContext skipped; reusing existing BrowserContext",
        this.instanceId,
        this.browser,
        this.context,
        this.page
      );

      return this.context;
    }

    if (!this.browser) {
      this.browser = await browserTypeFor(this.config).launch({
        headless: this.config.headless,
      });
      logRuntimeInstances("browser launch completed", this.instanceId, this.browser, null, null);
    }

    const absoluteStorageStatePath = path.resolve(this.config.storageStatePath);
    const exists = await storageStateExists(this.config.storageStatePath);
    const storageState = exists
      ? await readStorageStateDiagnostic(this.config.storageStatePath)
      : null;
    const contextOptions = {
      storageState: options.storageState,
      baseURL: this.config.baseUrl,
    };

    console.info("[EliticalAuthService] storageState path", {
      storageStatePath: absoluteStorageStatePath,
    });
    console.info("[EliticalAuthService] storageState exists", {
      exists,
    });

    if (storageState) {
      logCookieDiagnostic(
        "storageState JSON cookies",
        Array.isArray(storageState.cookies) ? storageState.cookies : []
      );
      console.info("[EliticalAuthService] storageState JSON origins", {
        originCount: Array.isArray(storageState.origins)
          ? storageState.origins.length
          : 0,
      });
    }

    console.info("[EliticalAuthService] browser.newContext options", contextOptions);

    const context = await this.browser.newContext(contextOptions);
    this.context = context;
    const contextCookies = await context.cookies();

    logRuntimeInstances("browser.newContext completed", this.instanceId, this.browser, context, null);
    logCookieDiagnostic("BrowserContext cookies after newContext", contextCookies);

    return context;
  }

  private async ensurePage(context: BrowserContext) {
    if (this.page && !this.page.isClosed()) {
      logRuntimeInstances(
        "browser.newPage skipped; reusing existing Page",
        this.instanceId,
        this.browser,
        context,
        this.page
      );

      return this.page;
    }

    this.page = await context.newPage();
    logRuntimeInstances("browser.newPage completed", this.instanceId, this.browser, context, this.page);

    return this.page;
  }

  private async verifySession(page: Page) {
    const endpoint = verificationUrl(this.config);
    const visibleCookies = await page.context().cookies(endpoint);

    logCookieDiagnostic("cookies visible before verification request", visibleCookies);

    if (!page.url().startsWith(this.config.baseUrl)) {
      try {
        console.info("[EliticalAuthService] opening verification origin", {
          url: this.config.baseUrl,
          method: "GET",
        });
        const originResponse = await page.goto(this.config.baseUrl, {
          waitUntil: "load",
          timeout: this.config.verificationTimeoutMs,
        });

        console.info("[EliticalAuthService] verification origin response", {
          requestUrl: this.config.baseUrl,
          httpStatus: originResponse?.status() || 0,
          finalUrl: page.url(),
          responseHeaders: originResponse ? await originResponse.allHeaders() : {},
        });
      } catch (error) {
        console.info("[EliticalAuthService] verification origin network error", {
          requestUrl: this.config.baseUrl,
          method: "GET",
          error: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    }

    let browserState: {
      locationHref: string;
      cookie: string;
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
    };

    try {
      browserState = await page.evaluate(() => {
        const localStorageEntries: Record<string, string> = {};
        const sessionStorageEntries: Record<string, string> = {};

        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index) || "";
          localStorageEntries[key] = window.localStorage.getItem(key) || "";
        }

        for (let index = 0; index < window.sessionStorage.length; index += 1) {
          const key = window.sessionStorage.key(index) || "";
          sessionStorageEntries[key] = window.sessionStorage.getItem(key) || "";
        }

      return {
        locationHref: document.location.href,
        cookie: document.cookie,
          localStorage: localStorageEntries,
          sessionStorage: sessionStorageEntries,
      };
      });
    } catch (error) {
      console.info("[EliticalAuthService] unable to read verification browser state", {
        locationHref: page.url(),
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }

    console.info("[EliticalAuthService] verification browser state", {
      locationHref: browserState.locationHref,
      cookie: browserState.cookie,
      localStorage: summarizeStorage(browserState.localStorage),
      sessionStorage: summarizeStorage(browserState.sessionStorage),
    });
    console.info("[EliticalAuthService] verification request", {
      url: endpoint,
      method: "GET",
      executionContext: "page.evaluate(fetch)",
      fetchOptions: {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: "localStorage:flutter.authorization",
          "s-jwt-token": "localStorage:flutter.s-jwt-token",
        },
      },
    });

    const result = await page.evaluate(
      async (url): Promise<VerificationFetchResult> => {
        try {
          const headers: Record<string, string> = {
            accept: "application/json",
            "content-type": "application/json",
          };
          let authorization = window.localStorage.getItem("flutter.authorization");
          let sJwtToken = window.localStorage.getItem("flutter.s-jwt-token");

          try {
            const parsedAuthorization = JSON.parse(authorization || "");
            if (typeof parsedAuthorization === "string") {
              authorization = parsedAuthorization;
            }
          } catch {
            // Keep the raw localStorage value when it is not JSON encoded.
          }

          try {
            const parsedSJwtToken = JSON.parse(sJwtToken || "");
            if (typeof parsedSJwtToken === "string") {
              sJwtToken = parsedSJwtToken;
            }
          } catch {
            // Keep the raw localStorage value when it is not JSON encoded.
          }

          if (authorization) headers.authorization = authorization;
          if (sJwtToken) headers["s-jwt-token"] = sJwtToken;

          const response = await fetch(url, {
            method: "GET",
            headers,
          });
          const responseHeaders = Object.fromEntries(response.headers.entries());
          const refreshedAuthorization = responseHeaders.authorization;

          if (refreshedAuthorization) {
            window.localStorage.setItem(
              "flutter.authorization",
              refreshedAuthorization
            );
          }
          const body = await response.text();

          return {
            ok: response.ok,
            status: response.status,
            finalUrl: response.url,
            headers: responseHeaders,
            body,
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            finalUrl: url,
            headers: {},
            body: "",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      endpoint
    );

    console.info("[EliticalAuthService] verification response", {
      requestUrl: endpoint,
      method: "GET",
      httpStatus: result.status,
      finalUrl: result.finalUrl,
      responseHeaders: result.headers,
      responseBodyFirst1000: result.body.slice(0, 1000),
      networkError: result.error || "",
    });

    if (result.status === 401) {
      console.error("[EliticalAuthService] first verification 401", {
        authServiceInstanceId: this.instanceId,
        requestUrl: endpoint,
        method: "GET",
        finalUrl: result.finalUrl,
        callStack: new Error().stack,
      });
    }

    if (result.error) {
      throw new EliticalAuthError(
        "SESSION_INVALID",
        "Elitical verification request failed.",
        { cause: result.error }
      );
    }

    if (!result.ok) {
      return null;
    }

    if (result.headers.authorization) {
      await this.persistSession(page.context());
    }

    let payload: unknown = null;

    try {
      payload = JSON.parse(result.body);
    } catch {
      payload = result.body;
    }

    if (!isRecord(payload)) {
      throw new EliticalAuthError(
        "SESSION_INVALID",
        "Elitical verification response was not valid JSON."
      );
    }

    return payloadToSession(payload as VerificationPayload);
  }

  private async waitForAuthenticatedSession(page: Page) {
    const deadline = Date.now() + this.config.loginTimeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      try {
        const session = await this.verifySession(page);

        if (session) return session;
      } catch (error) {
        lastError = error;
      }

      await page.waitForTimeout(1_000);
    }

    throw new EliticalAuthError(
      "LOGIN_FAILED",
      "Timed out waiting for Elitical authentication.",
      { cause: lastError }
    );
  }

  private async persistSession(context: BrowserContext) {
    try {
      await mkdir(path.dirname(this.config.storageStatePath), {
        recursive: true,
      });
      await context.storageState({
        path: this.config.storageStatePath,
      });
    } catch (error) {
      throw new EliticalAuthError(
        "SESSION_STORAGE_FAILED",
        "Unable to persist Elitical session.",
        { cause: error }
      );
    }
  }

  private async closeRuntime() {
    const page = this.page;
    const context = this.context;
    const browser = this.browser;

    this.page = null;
    this.context = null;
    this.browser = null;

    await page?.close();
    await context?.close();
    await browser?.close();
  }
}
