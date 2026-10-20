import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getClaudeAutoModel,
  getConfig,
  invalidateConfigCache,
  reloadConfig,
  writeConfigToDisk,
  type AppConfig,
} from "~/lib/config-store"
import { reloadServerConfig } from "~/lib/config-reload"
import * as configModule from "~/lib/config"
import * as credentials from "~/lib/credential-store"
import { PATHS } from "~/lib/paths"
import { state, type State } from "~/lib/state"
import * as tokens from "~/lib/token"
import type { CodexCredentials } from "~/lib/oauth/codex"
import * as models from "~/services/copilot/models-cache"
import * as vscode from "~/services/vscode-env"
import { createServer } from "~/server"
import { createManagedAuthenticator } from "~/users/managed-auth"
import type { GetCopilotTokenResponse } from "~/services/github/get-copilot-token"
import { createFakeKeysGateway } from "./fake-keys-gateway"

const originalPaths = { appDir: PATHS.APP_DIR, configPath: PATHS.CONFIG_PATH }
const setupCopilotToken = tokens.setupCopilotToken
const stopCopilotRefreshLoop = tokens.stopCopilotRefreshLoop
let tempDir: string
let originalState: State
let setupCopilotTokenMock: Mock<typeof tokens.setupCopilotToken>
let stopModelsRefreshLoopMock: Mock<typeof models.stopModelsRefreshLoop>

function saveConfig(overrides: AppConfig = {}): void {
  writeConfigToDisk({
    auth: { apiKeys: ["old-api"], adminApiKey: "old-admin" },
    providers: { "github-copilot": { enabled: false } },
    ...overrides,
  })
}

function createCodexCredentials(accountId: string): CodexCredentials {
  return {
    accountId,
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: 0,
  }
}

beforeEach(() => {
  originalState = { ...state }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-config-reload-"))
  PATHS.APP_DIR = tempDir
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  saveConfig()
  reloadConfig()
  spyOn(configModule, "getRawProviderConfig").mockImplementation(
    (providerName) => getConfig().providers?.[providerName] ?? null,
  )
  state.githubToken = undefined
  state.githubTokenSource = undefined
  state.copilotToken = undefined
  state.models = undefined
  spyOn(credentials, "readGitHubTokenFromEnv").mockReturnValue(undefined)
  spyOn(credentials, "readGitHubToken").mockResolvedValue("saved-github-token")
  spyOn(tokens, "stopCopilotRefreshLoop").mockImplementation(() => {})
  spyOn(tokens, "stopCodexRefreshLoop").mockImplementation(() => {})
  spyOn(tokens, "logUser").mockImplementation(() => {
    state.userName = "test-user"
    return Promise.resolve()
  })
  setupCopilotTokenMock = spyOn(tokens, "setupCopilotToken").mockImplementation(
    () => {
      state.copilotToken = `copilot-${state.githubToken}`
      return Promise.resolve()
    },
  )
  spyOn(models, "cacheModels").mockImplementation(() => {
    state.models = { object: "list", data: [] }
    return Promise.resolve()
  })
  stopModelsRefreshLoopMock = spyOn(
    models,
    "stopModelsRefreshLoop",
  ).mockImplementation(() => {})
  spyOn(vscode, "cacheVSCodeVersion").mockResolvedValue(undefined)
  spyOn(vscode, "cacheMacMachineId").mockImplementation(() => {})
  spyOn(vscode, "cacheVsCodeSessionId").mockImplementation(() => {})
  spyOn(vscode, "cacheVsCodeDeviceId").mockResolvedValue(undefined)
})

afterEach(() => {
  mock.restore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, originalState)
  PATHS.APP_DIR = originalPaths.appDir
  PATHS.CONFIG_PATH = originalPaths.configPath
  invalidateConfigCache()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("running server config reload", () => {
  test("loads provider settings and API keys from the latest file", async () => {
    saveConfig({
      auth: { apiKeys: ["new-api"], adminApiKey: "new-admin" },
      providers: {
        "github-copilot": { enabled: false },
        codex: { enabled: false },
        custom: { enabled: true, apiKey: "new-key" },
      },
      useMessagesApi: false,
    })
    await reloadServerConfig()
    expect(getConfig().auth?.apiKeys).toEqual(["new-api"])
    expect(getConfig().providers?.custom?.apiKey).toBe("new-key")
    expect(getConfig().useMessagesApi).toBe(false)
    expect(tokens.stopCodexRefreshLoop).toHaveBeenCalledTimes(1)
    expect(tokens.stopCopilotRefreshLoop).toHaveBeenCalledTimes(1)
    expect(models.stopModelsRefreshLoop).toHaveBeenCalledTimes(1)
    expect(tokens.setupCopilotToken).not.toHaveBeenCalled()
  })

  test("keeps the last working config after invalid JSON and allows a retry", async () => {
    const previous = getConfig()
    fs.writeFileSync(PATHS.CONFIG_PATH, "{invalid json")
    const failure = await reloadServerConfig().catch((error: unknown) => error)
    expect(failure).toHaveProperty(
      "message",
      expect.stringContaining("not valid JSON"),
    )
    expect(getConfig()).toBe(previous)
    expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe("{invalid json")
    saveConfig({ useMessagesApi: false })
    await reloadServerConfig()
    expect(getConfig().useMessagesApi).toBe(false)
  })

  test("initializes tokens and models when Copilot is enabled while running", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    expect(getClaudeAutoModel(true)).toBeUndefined()
    await reloadServerConfig()
    expect(state.githubToken).toBe("saved-github-token")
    expect(state.githubTokenSource).toBe("file")
    expect(state.copilotToken).toBe("copilot-saved-github-token")
    expect(state.models?.data).toEqual([])
    expect(tokens.logUser).toHaveBeenCalledTimes(1)
    expect(tokens.setupCopilotToken).toHaveBeenCalledTimes(1)
    expect(getClaudeAutoModel(true)).toBe("gpt-6-luna")
  })

  test("keeps established Copilot credentials on an ordinary config reload", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    await reloadServerConfig()
    await reloadServerConfig()
    expect(tokens.setupCopilotToken).toHaveBeenCalledTimes(1)
  })

  test("reloads changed GitHub credentials without restarting the process", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    await reloadServerConfig()
    spyOn(credentials, "readGitHubToken").mockResolvedValue("changed-token")
    await reloadServerConfig()
    expect(state.githubToken).toBe("changed-token")
    expect(state.copilotToken).toBe("copilot-changed-token")
  })

  test("preserves CLI token precedence over environment and saved tokens", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    state.githubTokenSource = "cli"
    state.githubToken = "cli-token"
    spyOn(credentials, "readGitHubTokenFromEnv").mockReturnValue("env-token")
    await reloadServerConfig()
    expect(state.githubToken).toBe("cli-token")
    expect(state.githubTokenSource).toBe("cli")
    expect(credentials.readGitHubToken).not.toHaveBeenCalled()
  })

  test("uses an environment token before the saved token", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    spyOn(credentials, "readGitHubTokenFromEnv").mockReturnValue("env-token")
    await reloadServerConfig()
    expect(state.githubToken).toBe("env-token")
    expect(state.githubTokenSource).toBe("env")
    expect(credentials.readGitHubToken).not.toHaveBeenCalled()
  })

  test("clears Copilot credentials when the saved token is removed", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    await reloadServerConfig()
    expect(getClaudeAutoModel(true)).toBe("gpt-6-luna")
    spyOn(credentials, "readGitHubToken").mockResolvedValue(null)
    await reloadServerConfig()
    expect(state.githubToken).toBeUndefined()
    expect(state.copilotToken).toBeUndefined()
    expect(state.models).toBeUndefined()
    expect(state.userName).toBeUndefined()
    expect(getClaudeAutoModel(true)).toBeUndefined()
    // Once for the reinitialized runtime, once for the removed token.
    expect(models.stopModelsRefreshLoop).toHaveBeenCalledTimes(2)
  })

  test("allows a retry after Copilot initialization fails", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    spyOn(tokens, "logUser").mockRejectedValueOnce(
      new Error("upstream offline"),
    )
    const failure = await reloadServerConfig().catch((error: unknown) => error)
    expect(failure).toHaveProperty("message", "upstream offline")
    await reloadServerConfig()
    expect(state.copilotToken).toBe("copilot-saved-github-token")
  })

  test("stops the models loop before a token switch that fails to initialize", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    await reloadServerConfig()
    expect(state.models).toBeDefined()

    const calls: Array<string> = []
    stopModelsRefreshLoopMock.mockImplementation(() => {
      calls.push("stopModelsRefreshLoop")
    })
    setupCopilotTokenMock.mockImplementationOnce(() => {
      calls.push("setupCopilotToken")
      return Promise.reject(new Error("upstream offline"))
    })
    spyOn(credentials, "readGitHubToken").mockResolvedValue("changed-token")

    // setupCopilotToken() runs before cacheModels(), so this never reaches the
    // point where a new models generation would supersede the old one.
    const failure = await reloadServerConfig().catch((error: unknown) => error)
    expect(failure).toHaveProperty("message", "upstream offline")
    expect(calls).toEqual(["stopModelsRefreshLoop", "setupCopilotToken"])
    expect(state.models).toBeUndefined()
  })

  test("serializes reloads instead of losing config changes during initialization", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    const initializing = Promise.withResolvers<void>()
    spyOn(tokens, "logUser").mockImplementationOnce(() => initializing.promise)
    const first = reloadServerConfig()
    await Promise.resolve()
    await Promise.resolve()
    saveConfig({ useMessagesApi: false })
    const second = reloadServerConfig()
    initializing.resolve()
    await Promise.all([first, second])
    expect(getConfig().useMessagesApi).toBe(false)
    expect(getConfig().providers?.["github-copilot"]?.enabled).toBe(false)
  })

  // NEW CONTRACT (post-strip): downstream client keys are no longer a static
  // `auth.apiKeys` array that a config reload rotates. They live in
  // `agent_gateway.client_keys` and are rotated by the gateway admin UI; the
  // proxy picks a change up within the authenticator's short TTL. The two tests
  // below lock that contract (the admin-endpoint key rotation is still covered
  // by "rejects unauthenticated..." and "regenerates an emptied admin key").
  test("rotates client keys within the authenticator TTL, honouring the old key until it expires", async () => {
    const keys = createFakeKeysGateway([{ key: "old", userId: "u1" }])
    let now = 1_000_000
    spyOn(Date, "now").mockImplementation(() => now)
    const authenticator = createManagedAuthenticator(keys, {
      cacheTtlMs: 30_000,
    })

    expect((await authenticator.authenticate("old")).ok).toBe(true)

    // The gateway admin rotates the key: "old" removed, "new" added.
    keys.setKeys([{ key: "new", userId: "u1" }])

    // The new key authenticates on its very first request — it was never cached
    // as a miss.
    expect((await authenticator.authenticate("new")).ok).toBe(true)

    // The old key keeps working until its positive cache entry ages out.
    expect((await authenticator.authenticate("old")).ok).toBe(true)

    // Past the TTL the old key is re-checked against client_keys and rejected.
    now += 30_001
    const afterTtl = await authenticator.authenticate("old")
    expect(afterTtl.ok).toBe(false)
    expect(afterTtl.ok ? 0 : afterTtl.status).toBe(401)
  })

  test("rejects unauthenticated and ordinary API keys on the reload endpoint", async () => {
    const app = createServer()
    const unauthenticated = await app.request("/admin/config/reload", {
      method: "POST",
    })
    expect(unauthenticated.status).toBe(401)
    const ordinaryKey = await app.request("/admin/config/reload", {
      method: "POST",
      headers: { "x-api-key": "old-api" },
    })
    expect(ordinaryKey.status).toBe(401)
  })

  test("regenerates an emptied admin key during reload", async () => {
    const app = createServer()
    saveConfig({ auth: { apiKeys: ["old-api"] } })
    const response = await app.request("/admin/config/reload", {
      method: "POST",
      headers: { "x-api-key": "old-admin" },
    })
    expect(response.status).toBe(200)
    expect(getConfig().auth?.adminApiKey).toMatch(/^[a-f0-9]{64}$/)
  })

  test("never caches a negative client-key lookup, so a late-added key works at once", async () => {
    const keys = createFakeKeysGateway([])
    const authenticator = createManagedAuthenticator(keys, {
      cacheTtlMs: 30_000,
    })

    const first = await authenticator.authenticate("ghost")
    expect(first.ok).toBe(false)
    expect(first.ok ? 0 : first.status).toBe(401)
    expect(keys.calls).toBe(1)

    // The gateway admin adds the key a moment later — well inside the TTL.
    keys.setKeys([{ key: "ghost", userId: "u2" }])

    const second = await authenticator.authenticate("ghost")
    expect(second.ok).toBe(true)
    // The backend was consulted again: the 401 was never cached.
    expect(keys.calls).toBe(2)
  })

  test("does not apply a stale token after its refresh loop is stopped", async () => {
    saveConfig({ providers: { "github-copilot": { enabled: true } } })
    reloadConfig()
    const refreshing = Promise.withResolvers<GetCopilotTokenResponse>()
    const refreshStarted = Promise.withResolvers<void>()
    const initialToken: GetCopilotTokenResponse = {
      expires_at: 0,
      refresh_in: 0,
      token: "initial-token",
    }
    let fetchCount = 0
    await setupCopilotToken({
      getCopilotUsage: () => Promise.resolve(null),
      getCopilotToken: () => {
        fetchCount += 1
        if (fetchCount === 1) return Promise.resolve(initialToken)
        refreshStarted.resolve()
        return refreshing.promise
      },
    })
    try {
      await refreshStarted.promise
      stopCopilotRefreshLoop()
      refreshing.resolve({ ...initialToken, token: "stale-token" })
      await Promise.resolve()
      await Promise.resolve()
      expect(state.copilotToken).toBe("initial-token")
    } finally {
      stopCopilotRefreshLoop()
    }
  })

  test("stops the previous Codex refresh loop when the selected account changes", async () => {
    saveConfig({
      providers: {
        "github-copilot": { enabled: false },
        codex: { accountId: "account-a" },
      },
    })
    reloadConfig()
    saveConfig({
      providers: {
        "github-copilot": { enabled: false },
        codex: { accountId: "account-b" },
      },
    })
    await reloadServerConfig()
    expect(tokens.stopCodexRefreshLoop).toHaveBeenCalledTimes(1)
  })

  test("keeps Codex refresh attempts separate when accounts switch", async () => {
    const accountA = createCodexCredentials("account-a")
    const accountB = createCodexCredentials("account-b")
    const refreshingA = Promise.withResolvers<CodexCredentials>()
    const dependencies: tokens.CodexRefreshDependencies = {
      getCurrentCredentials: () => null,
      persistCodexCredentials: mock(() => Promise.resolve()),
      refreshCodexCredentials: mock((snapshot: CodexCredentials) =>
        snapshot.accountId === accountA.accountId ?
          refreshingA.promise
        : Promise.resolve({ ...snapshot, accessToken: "refreshed-b" }),
      ),
    }
    const first = tokens.refreshCodexCredentialsOnce(accountA, dependencies)
    expect(tokens.refreshCodexCredentialsOnce(accountA, dependencies)).toBe(
      first,
    )
    const second = await tokens.refreshCodexCredentialsOnce(
      accountB,
      dependencies,
    )
    refreshingA.resolve({ ...accountA, accessToken: "refreshed-a" })
    expect((await first).accountId).toBe("account-a")
    expect(second.accountId).toBe("account-b")
    expect(second.accessToken).toBe("refreshed-b")
    expect(dependencies.refreshCodexCredentials).toHaveBeenCalledTimes(2)
  })

  test("does not reuse another Codex account's rotated credentials", async () => {
    const accountB = createCodexCredentials("account-b")
    const dependencies: tokens.CodexRefreshDependencies = {
      getCurrentCredentials: () => ({
        ...createCodexCredentials("account-a"),
        expiresAt: Date.now() + 60_000,
      }),
      persistCodexCredentials: () => Promise.resolve(),
      refreshCodexCredentials: mock((snapshot: CodexCredentials) =>
        Promise.resolve({ ...snapshot, accessToken: "refreshed-b" }),
      ),
    }
    const result = await tokens.refreshCodexCredentialsOnce(
      accountB,
      dependencies,
    )
    expect(result.accountId).toBe("account-b")
    expect(dependencies.refreshCodexCredentials).toHaveBeenCalledWith(accountB)
  })

  test("keeps a failed Codex persistence retry isolated from other accounts", async () => {
    const accountA = createCodexCredentials("account-a")
    const accountB = createCodexCredentials("account-b")
    const dependenciesA: tokens.CodexRefreshDependencies = {
      getCurrentCredentials: () => null,
      persistCodexCredentials: mock(() =>
        Promise.resolve(),
      ).mockRejectedValueOnce(new Error("disk unavailable")),
      refreshCodexCredentials: mock(() =>
        Promise.resolve({ ...accountA, accessToken: "refreshed-a" }),
      ),
    }
    const failure = await tokens
      .refreshCodexCredentialsOnce(accountA, dependenciesA)
      .catch((error: unknown) => error)
    expect(failure).toHaveProperty("message", "disk unavailable")
    const resultB = await tokens.refreshCodexCredentialsOnce(accountB, {
      getCurrentCredentials: () => null,
      persistCodexCredentials: () => Promise.resolve(),
      refreshCodexCredentials: (snapshot) => Promise.resolve(snapshot),
    })
    expect(resultB.accountId).toBe("account-b")
    const retriedA = await tokens.refreshCodexCredentialsOnce(
      accountA,
      dependenciesA,
    )
    expect(retriedA.accessToken).toBe("refreshed-a")
    expect(dependenciesA.refreshCodexCredentials).toHaveBeenCalledTimes(1)
  })

  test("discards failed refresh persistence for a new sign-in without losing another account's retry", async () => {
    const accountA = createCodexCredentials("pending-signin-a")
    const accountB = createCodexCredentials("pending-signin-b")
    const createDependencies = (snapshot: CodexCredentials) => ({
      getCurrentCredentials: () => null,
      persistCodexCredentials: mock(() =>
        Promise.resolve(),
      ).mockRejectedValueOnce(new Error("disk unavailable")),
      refreshCodexCredentials: mock(() =>
        Promise.resolve({ ...snapshot, accessToken: "rotated-access" }),
      ),
    })
    const dependenciesA = createDependencies(accountA)
    const dependenciesB = createDependencies(accountB)
    for (const [snapshot, dependencies] of [
      [accountA, dependenciesA],
      [accountB, dependenciesB],
    ] as const) {
      const failure = await tokens
        .refreshCodexCredentialsOnce(snapshot, dependencies)
        .catch((error: unknown) => error)
      expect(failure).toHaveProperty("message", "disk unavailable")
    }
    spyOn(credentials, "writeCodexCredentials").mockResolvedValue(undefined)
    await tokens.persistCodexCredentials({
      ...accountA,
      accessToken: "new-signin-access",
    })
    await tokens.refreshCodexCredentialsOnce(accountA, dependenciesA)
    await tokens.refreshCodexCredentialsOnce(accountB, dependenciesB)
    expect(dependenciesA.refreshCodexCredentials).toHaveBeenCalledTimes(2)
    expect(dependenciesB.refreshCodexCredentials).toHaveBeenCalledTimes(1)
  })

  test("does not replace the active account when an old Codex refresh persists", async () => {
    saveConfig({
      providers: {
        "github-copilot": { enabled: false },
        codex: { accountId: "account-b" },
      },
    })
    reloadConfig()
    state.codexAccountId = "account-b"
    state.codexAccessToken = "active-b"
    spyOn(credentials, "writeCodexCredentials").mockResolvedValue(undefined)
    await tokens.persistCodexCredentials(createCodexCredentials("account-a"), {
      syncProvider: false,
      insertIfMissing: false,
    })
    expect(state.codexAccountId).toBe("account-b")
    expect(state.codexAccessToken).toBe("active-b")
    await tokens.persistCodexCredentials(createCodexCredentials("account-b"), {
      syncProvider: false,
      insertIfMissing: false,
    })
    expect(state.codexAccountId).toBe("account-b")
    expect(state.codexAccessToken).toBe("access-account-b")
  })
})
