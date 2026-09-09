import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, patchSettings, testLlmConnection } from "@/api/endpoints";
import type { Settings as SettingsData } from "@/api/types";
import { readApiError } from "@/api/client";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ModelsCard } from "./ModelsCard";
import { McpCard } from "./McpCard";

// Provider presets. Each base is the full prefix up to /v1 because the backend
// calls `${base}/chat/completions`. Choosing a preset fills the API Base and a
// placeholder model; "custom" lets the user type both freely.
type ProviderKey =
  | "deepseek"
  | "openai"
  | "qwen"
  | "moonshot"
  | "zhipu"
  | "ollama"
  | "custom";

interface Provider {
  key: ProviderKey;
  label: string;
  base: string;
  modelPlaceholder: string;
}

const PROVIDERS: Provider[] = [
  { key: "deepseek", label: "DeepSeek", base: "https://api.deepseek.com", modelPlaceholder: "deepseek-v4-pro" },
  { key: "openai", label: "OpenAI", base: "https://api.openai.com/v1", modelPlaceholder: "gpt-4o" },
  { key: "qwen", label: "通义千问 Qwen", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelPlaceholder: "qwen-plus" },
  { key: "moonshot", label: "Moonshot Kimi", base: "https://api.moonshot.cn/v1", modelPlaceholder: "moonshot-v1-8k" },
  { key: "zhipu", label: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", modelPlaceholder: "glm-4-plus" },
  { key: "ollama", label: "Ollama 本地", base: "http://localhost:11434/v1", modelPlaceholder: "llama3.1" },
  { key: "custom", label: "自定义", base: "", modelPlaceholder: "model-name" },
];

// Infer which preset matches a given base URL (so a server-stored base maps back
// to its dropdown entry). Anything unrecognised falls through to "custom".
function providerForBase(base: string): ProviderKey {
  const trimmed = (base || "").replace(/\/+$/, "");
  const match = PROVIDERS.find((p) => p.key !== "custom" && p.base.replace(/\/+$/, "") === trimmed);
  return match ? match.key : "custom";
}

export function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });

  const [provider, setProvider] = useState<ProviderKey>("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Drives the destructive二次确认 before clearing the API key.
  const [confirmClear, setConfirmClear] = useState(false);

  // Seed the editable base/model from the server once loaded, preferring the
  // generic llm_* fields and falling back to the legacy deepseek_* aliases. The
  // key itself is never returned by the backend, so its field starts blank.
  useEffect(() => {
    if (settings.data) {
      const base = settings.data.llm_api_base ?? settings.data.deepseek_api_base ?? "";
      const mdl = settings.data.llm_model ?? settings.data.deepseek_model ?? "";
      setApiBase(base);
      setModel(mdl);
      const stored = settings.data.llm_provider;
      setProvider(stored && PROVIDERS.some((p) => p.key === stored)
        ? (stored as ProviderKey)
        : providerForBase(base));
    }
  }, [settings.data]);

  const onPickProvider = (key: ProviderKey) => {
    setProvider(key);
    const preset = PROVIDERS.find((p) => p.key === key);
    if (preset && key !== "custom") {
      setApiBase(preset.base);
      // Only auto-fill the model when it's empty or still holding another
      // preset's placeholder value, so we don't clobber a user-typed model.
      const presetModels = PROVIDERS.map((p) => p.modelPlaceholder);
      if (!model.trim() || presetModels.includes(model.trim())) {
        setModel(preset.modelPlaceholder);
      }
    }
  };

  const save = useMutation({
    mutationFn: () =>
      patchSettings({
        ...(apiKey.trim() ? { llm_api_key: apiKey.trim() } : {}),
        llm_api_base: apiBase.trim(),
        llm_model: model.trim(),
        llm_provider: provider,
      }),
    onSuccess: (data) => {
      setApiKey("");
      setInfo("已保存。会议纪要、对话情绪语义分析、改纪要将使用该配置。");
      setError(null);
      // Write the fresh view straight into the cache so the "已配置" badge flips
      // immediately and deterministically, regardless of refetch timing /
      // staleTime. invalidate kicks a background refetch for good measure.
      qc.setQueryData<SettingsData>(["settings"], data);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => {
      setError(readApiError(err));
      setInfo(null);
    },
  });

  const clearKey = useMutation({
    mutationFn: () => patchSettings({ llm_api_key: "" }),
    onSuccess: (data) => {
      setApiKey("");
      setInfo("已清除 API Key。纪要相关功能将不可用，转写与声学情绪不受影响。");
      setError(null);
      qc.setQueryData<SettingsData>(["settings"], data);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(readApiError(err)),
  });

  // "测试连接": probe the live endpoint with exactly what's on screen, without
  // writing anything to disk. The current form values are passed as overrides so
  // the user can validate a key/base/model before committing it via「保存」.
  const test = useMutation({
    mutationFn: () =>
      testLlmConnection({
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        ...(apiBase.trim() ? { api_base: apiBase.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      }),
    onSuccess: (result) => {
      if (result.ok) {
        setInfo(`✓ 连接正常，测试通过（模型 ${result.model}，耗时 ${result.latency_ms} ms）。`);
        setError(null);
      } else {
        setError(result.error || "测试失败。");
        setInfo(null);
      }
    },
    onError: (err) => {
      setError(readApiError(err));
      setInfo(null);
    },
  });

  const configured = settings.data?.llm_configured ?? settings.data?.deepseek_configured ?? false;
  const activePreset = PROVIDERS.find((p) => p.key === provider);

  return (
    <div className="container container--content">
      <div className="page-shell">
        <PageHead
          title="设置"
          subtitle={`本地单机运行。大模型：${configured ? `已配置（${activePreset?.label ?? "自定义"}）` : "未配置"}。`}
        />

        <div className="page-content page-content--stack">
          <section className="card stack-card">
        <div className="row">
          <h3 className="text-subhead form-section__title">大模型（LLM）</h3>
          <Status tone={configured ? "moss" : "muted"}>
            {configured ? "已配置" : "未配置"}
          </Status>
        </div>

        <p className="text-caption t-2" style={{ margin: 0 }}>
          支持任意 OpenAI 兼容接口。API Key 只保存在本机（应用数据目录的 config.json），不会上传，也不会在此页回显。
        </p>

        <label className="field">
          <span className="label">提供商</span>
          <select
            className="select"
            value={provider}
            onChange={(e) => onPickProvider(e.target.value as ProviderKey)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="label">API Key</span>
          <input
            className="input"
            type="password"
            placeholder={configured ? "已配置（留空则保持不变）" : "sk-..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="field">
          <span className="label">API Base（完整到 /v1）</span>
          <input
            className="input"
            type="text"
            placeholder={activePreset && activePreset.base ? activePreset.base : "https://your-endpoint/v1"}
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="label">模型</span>
          <input
            className="input"
            type="text"
            placeholder={activePreset ? activePreset.modelPlaceholder : "model-name"}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>

        <div className="row">
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            onClick={() => { setError(null); setInfo(null); save.mutate(); }}
          >
            <Icon name="save" size={14} /> 保存
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={test.isPending}
            onClick={() => { setError(null); setInfo(null); test.mutate(); }}
          >
            {test.isPending ? "测试中…" : "测试连接"}
          </Button>
          {configured && (
            <Button
              variant="danger"
              size="sm"
              loading={clearKey.isPending}
              onClick={() => { setError(null); setInfo(null); setConfirmClear(true); }}
              style={{ marginInlineStart: "auto" }}
            >
                清除 Key
              </Button>
            )}
          </div>

          {error && <Diag code="SET_E">{error}</Diag>}
          {info && <Diag code="SET_OK" tone="info">{info}</Diag>}
        </section>

          <ModelsCard />

          <McpCard />
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        tone="danger"
        title="清除 API Key"
        body="确定清除 API Key？纪要相关功能将不可用，转写与声学情绪不受影响。"
        confirmText="清除"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          setError(null);
          setInfo(null);
          clearKey.mutate();
        }}
      />
    </div>
  );
}
