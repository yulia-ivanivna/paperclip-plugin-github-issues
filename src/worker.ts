import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type PluginWebhookInput,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { TOOL_NAMES, WEBHOOK_KEYS, JOB_KEYS } from "./constants.js";
import * as github from "./github.js";
import * as sync from "./sync.js";

let pluginCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    ctx.logger.info("GitHub Issues Sync plugin starting");

    // ---------------------------------------------------------------
    // Helper: resolve the GitHub token from config
    // ---------------------------------------------------------------
    async function resolveToken(): Promise<string> {
      const config = await ctx.config.get();
      const ref = config.githubTokenRef as string | undefined;
      if (!ref) throw new Error("githubTokenRef not configured");
      return ctx.secrets.resolve(ref);
    }

    // ---------------------------------------------------------------
    // Agent tool: search GitHub issues
    // ---------------------------------------------------------------
    ctx.tools.register(
      TOOL_NAMES.search,
      {
        displayName: "Search GitHub Issues",
        description: "Search GitHub issues in a configured repository.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            repo: {
              type: "string",
              description: "Repository in owner/repo format. Optional if defaultRepo is configured.",
            },
          },
          required: ["query"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
      const input = params as { query?: string; repo?: string };
      const token = await resolveToken();
      const config = await ctx.config.get();
      const repo =
        (input.repo as string) ||
        (config.defaultRepo as string) ||
        "";
      if (!repo) {
        return {
          error:
            "No repository specified. Pass repo parameter or configure a default repository.",
        };
      }
      const query = input.query as string;
      const results = await github.searchIssues(
        ctx.http.fetch.bind(ctx.http),
        token,
        repo,
        query,
      );
      return {
        content: `Found ${results.total_count} GitHub issue(s) in ${repo}.`,
        data: {
          total_count: results.total_count,
          issues: results.items.map((issue) => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            url: issue.html_url,
            labels: issue.labels.map((l) => l.name),
            assignees: issue.assignees.map((a) => a.login),
            updated_at: issue.updated_at,
          })),
        },
      };
    });

    // ---------------------------------------------------------------
    // Agent tool: link a GitHub issue to the current Paperclip issue
    // ---------------------------------------------------------------
    ctx.tools.register(
      TOOL_NAMES.link,
      {
        displayName: "Link GitHub Issue",
        description: "Link a GitHub issue to a Paperclip issue for sync.",
        parametersSchema: {
          type: "object",
          properties: {
            ghIssueUrl: {
              type: "string",
              description: "GitHub issue URL or owner/repo#number",
            },
            issueId: {
              type: "string",
              description: "Paperclip issue ID to link when no issue context is available.",
            },
          },
          required: ["ghIssueUrl"],
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
      const input = params as { ghIssueUrl?: string; issueId?: string };
      const token = await resolveToken();
      const config = await ctx.config.get();
      const defaultRepo = config.defaultRepo as string | undefined;
      const ref = github.parseGitHubIssueRef(
        input.ghIssueUrl as string,
        defaultRepo,
      );
      if (!ref) {
        return { error: "Could not parse GitHub issue reference." };
      }

      const issueId = input.issueId || "";
      const companyId = runCtx.companyId;
      if (!issueId || !companyId) {
        return {
          error: "issueId is required for linking a GitHub issue.",
        };
      }

      // Check if already linked
      const existing = await sync.getLink(ctx, issueId);
      if (existing) {
        return {
          error: `This issue is already linked to ${existing.ghOwner}/${existing.ghRepo}#${existing.ghNumber}. Unlink first.`,
        };
      }

      const ghIssue = await github.getIssue(
        ctx.http.fetch.bind(ctx.http),
        token,
        ref.owner,
        ref.repo,
        ref.number,
      );

      const syncDirection =
        (config.syncDirection as sync.IssueLink["syncDirection"]) ||
        "bidirectional";

      const link = await sync.createLink(ctx, {
        paperclipIssueId: issueId,
        paperclipCompanyId: companyId,
        ghOwner: ref.owner,
        ghRepo: ref.repo,
        ghNumber: ref.number,
        ghHtmlUrl: ghIssue.html_url,
        ghState: ghIssue.state,
        syncDirection,
      });

      return {
        content: `Linked ${issueId} to ${ref.owner}/${ref.repo}#${ref.number}.`,
        data: {
          linked: true,
          github_issue: {
            number: ghIssue.number,
            title: ghIssue.title,
            state: ghIssue.state,
            url: ghIssue.html_url,
          },
          sync_direction: link.syncDirection,
        },
      };
    });

    // ---------------------------------------------------------------
    // Agent tool: unlink
    // ---------------------------------------------------------------
    ctx.tools.register(
      TOOL_NAMES.unlink,
      {
        displayName: "Unlink GitHub Issue",
        description: "Remove the sync link between a GitHub issue and a Paperclip issue.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description: "Paperclip issue ID whose GitHub link should be removed.",
            },
          },
          required: ["issueId"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
      const input = params as { issueId?: string };
      const issueId = input.issueId;
      if (!issueId) {
        return {
          error: "issueId is required.",
        };
      }

      const removed = await sync.removeLink(ctx, issueId);
      return {
        content: removed ? `Unlinked ${issueId}.` : `No link existed for ${issueId}.`,
        data: { unlinked: removed },
      };
    });

    // ---------------------------------------------------------------
    // Paperclip event: issue status changed -> sync to GitHub
    // ---------------------------------------------------------------
    ctx.events.on("issue.updated", async (event) => {
      const payload = event.payload as Record<string, unknown>;
      const issueId =
        (typeof payload.id === "string" ? payload.id : undefined) ??
        event.entityId;
      if (!issueId) return;

      const status = typeof payload.status === "string" ? payload.status : undefined;
      if (!status) return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      try {
        const token = await resolveToken();
        await sync.syncToGitHub(ctx, link, status, token);
      } catch (err) {
        ctx.logger.error("Failed to sync status to GitHub", { error: err });
      }
    });

    // ---------------------------------------------------------------
    // Paperclip event: comment added -> bridge to GitHub
    // ---------------------------------------------------------------
    (ctx.events.on as unknown as (
      eventName: string,
      handler: (event: PluginEvent) => Promise<void>,
    ) => void)("issue.comment_added", async (event: PluginEvent) => {
      const config = await ctx.config.get();
      if (!config.syncComments) return;

      const payload = event.payload as Record<string, unknown>;
      const issueId = typeof payload.issueId === "string" ? payload.issueId : undefined;
      const body = typeof payload.body === "string" ? payload.body : undefined;
      const authorName =
        (typeof payload.authorName === "string" ? payload.authorName : undefined) || "Paperclip user";
      if (!issueId || !body) return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      try {
        const token = await resolveToken();
        await sync.bridgeCommentToGitHub(ctx, link, token, body, authorName);
      } catch (err) {
        ctx.logger.error("Failed to bridge comment to GitHub", { error: err });
      }
    });

    // ---------------------------------------------------------------
    // Periodic sync job: catch missed webhooks
    // ---------------------------------------------------------------
    ctx.jobs.register(JOB_KEYS.periodicSync, async () => {
      ctx.logger.info("Running periodic GitHub sync");

      // This is a simplified version - in production you'd iterate all
      // links stored in plugin state. The current SDK doesn't provide
      // a list/scan operation on state, so this job would need to maintain
      // its own index of linked issue IDs.
      //
      // For now, this job serves as the registration point. Full iteration
      // will be implemented once the plugin state API supports listing keys
      // or the plugin uses its own SQLite database.
      ctx.logger.info("Periodic sync complete (index-based iteration pending)");
    });

    // ---------------------------------------------------------------
    // UI data: provide link info for the issue detail tab
    // ---------------------------------------------------------------
    ctx.data.register("issue-link", async (params: Record<string, unknown>) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      if (!issueId) return { linked: false };
      const link = await sync.getLink(ctx, issueId);
      if (!link) return { linked: false };

      try {
        const token = await resolveToken();
        const ghIssue = await github.getIssue(
          ctx.http.fetch.bind(ctx.http),
          token,
          link.ghOwner,
          link.ghRepo,
          link.ghNumber,
        );
        return {
          linked: true,
          github: {
            number: ghIssue.number,
            title: ghIssue.title,
            state: ghIssue.state,
            url: ghIssue.html_url,
            labels: ghIssue.labels.map((l) => l.name),
            assignees: ghIssue.assignees.map((a) => a.login),
            updated_at: ghIssue.updated_at,
          },
          syncDirection: link.syncDirection,
          lastSyncAt: link.lastSyncAt,
        };
      } catch {
        return {
          linked: true,
          github: {
            number: link.ghNumber,
            url: link.ghHtmlUrl,
            state: link.lastGhState,
          },
          syncDirection: link.syncDirection,
          lastSyncAt: link.lastSyncAt,
          fetchError: true,
        };
      }
    });

    ctx.logger.info("GitHub Issues Sync plugin ready");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok", message: "GitHub Issues Sync operational" };
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey !== WEBHOOK_KEYS.github) return;
    if (!pluginCtx) return;

    const ctx = pluginCtx;
    const payload = input.parsedBody as Record<string, unknown> | undefined;
    if (!payload) return;

    const event = input.headers["x-github-event"];
    const eventName = Array.isArray(event) ? event[0] : event;
    if (!eventName) return;

    const action = payload.action as string | undefined;
    const issue = payload.issue as Record<string, unknown> | undefined;
    if (!issue) return;

    const number = issue.number as number;
    const repoObj = payload.repository as Record<string, unknown> | undefined;
    const fullName = repoObj?.full_name as string | undefined;
    if (!fullName) return;

    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) return;

    const link = await sync.getLinkByGitHub(ctx, owner, repo, number);
    if (!link) return;

    if (eventName === "issues" && (action === "closed" || action === "reopened")) {
      const ghState = (action === "closed" ? "closed" : "open") as "open" | "closed";
      await sync.syncFromGitHub(ctx, link, { state: ghState } as github.GitHubIssue);
      return;
    }

    if (eventName === "issue_comment" && action === "created") {
      const config = await ctx.config.get();
      if (!config.syncComments) return;

      const comment = payload.comment as Record<string, unknown> | undefined;
      const commentBody = comment?.body as string | undefined;
      if (!commentBody || commentBody.includes("[synced from Paperclip]")) return;

      const commentUser = (comment?.user as Record<string, unknown> | undefined)?.login as string | undefined;
      const commentUrl = comment?.html_url as string | undefined;
      await ctx.issues.createComment(
        link.paperclipIssueId,
        `**@${commentUser || "github-user"}** ([GitHub](${commentUrl || link.ghHtmlUrl})):\n\n${commentBody}`,
        link.paperclipCompanyId,
      );
    }
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    if (!config.githubTokenRef) {
      errors.push("githubTokenRef is required");
    }
    if (
      config.defaultRepo &&
      typeof config.defaultRepo === "string" &&
      !config.defaultRepo.includes("/")
    ) {
      errors.push("defaultRepo must be in owner/repo format");
    }
    return { ok: errors.length === 0, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
