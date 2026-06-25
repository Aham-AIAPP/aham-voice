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
import { Field, FormRow } from "@/components/Field";
import { ConfirmDialog } from "@/components/ConfirmDialog";

// 提供商预设。base 写到 /v1 这层（后端调用 `${base}/chat/completions`）。
type ProviderKey = "deepseek" | "openai" | "qwen" | "moonshot" | "zhipu" | "ollama" | "custom";

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

function providerForBase(base: string): ProviderKey {
  const trimmed = (base || "").replace(/\/+$/, "");
  const match = PROVIDERS.find((p) => p.key !== "custom" && p.base.replace(/\/+$/, "") === trimmed);
  return match ? match.key : "custom";
}

// 大模型配置（对齐 aham-voice 开源版）。支持任意 OpenAI 兼容接口。
// orchisky 多用户语义:仅管理员可改/测（后端 require_admin），配置全局单份存 config.json。
export function AdminSettings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });

  const [provider, setProvider] = useState<ProviderKey>("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // CRM（纪要回写 / 关联项目）配置
  const [crmBase, setCrmBase] = useState("");
  const [crmToken, setCrmToken] = useState("");
  const [crmError, setCrmError] = useState<string | null>(null);
  const [crmInfo, setCrmInfo] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      const base = settings.data.llm_api_base ?? settings.data.deepseek_api_base ?? "";
      const mdl = settings.data.llm_model ?? settings.data.deepseek_model ?? "";
      setApiBase(base);
      setModel(mdl);
      const stored = settings.data.llm_provider;
      setProvider(
        stored && PROVIDERS.some((p) => p.key === stored)
          ? (stored as ProviderKey)
          : providerForBase(base),
      );
      setCrmBase(settings.data.crm_base_url ?? "");
    }
  }, [settings.data]);

  const saveCrm = useMutation({
    mutationFn: () =>
      patchSettings({
        newcrm_base_url: crmBase.trim(),
        ...(crmToken.trim() ? { newcrm_token: crmToken.trim() } : {}),
      }),
    onSuccess: (data) => {
      setCrmToken("");
      setCrmInfo("已保存。生成纪要后可在录音详情页同步到 Orchisky CRM 并关联项目/商机。");
      setCrmError(null);
      qc.setQueryData<SettingsData>(["settings"], data);
    },
    onError: (err) => { setCrmError(readApiError(err)); setCrmInfo(null); },
  });

  const onPickProvider = (key: ProviderKey) => {
    setProvider(key);
    const preset = PROVIDERS.find((p) => p.key === key);
    if (preset && key !== "custom") {
      setApiBase(preset.base);
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
      // patchSettings 已返回权威配置，直接写缓存即可；不再 invalidate 触发 refetch，
      // 避免 refetch 回来后 useEffect 回填覆盖用户此刻仍在编辑的内容。
      qc.setQueryData<SettingsData>(["settings"], data);
    },
    onError: (err) => { setError(readApiError(err)); setInfo(null); },
  });

  const clearKey = useMutation({
    mutationFn: () => patchSettings({ llm_api_key: "" }),
    onSuccess: (data) => {
      setApiKey("");
      setInfo("已清除 API Key。纪要相关功能将不可用，转写与声学情绪不受影响。");
      setError(null);
      qc.setQueryData<SettingsData>(["settings"], data);
    },
    onError: (err) => setError(readApiError(err)),
  });

  const test = useMutation({
    mutationFn: () =>
      testLlmConnection({
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        ...(apiBase.trim() ? { api_base: apiBase.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      }),
    onSuccess: (result) => {
      if (result.ok) {
        setInfo(`连接正常，测试通过（模型 ${result.model}，耗时 ${result.latency_ms} ms）。`);
        setError(null);
      } else {
        setError(result.error || "测试失败。");
        setInfo(null);
      }
    },
    onError: (err) => { setError(readApiError(err)); setInfo(null); },
  });

  const configured = settings.data?.llm_configured ?? settings.data?.deepseek_configured ?? false;
  const activePreset = PROVIDERS.find((p) => p.key === provider);

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="系统配置"
        subtitle={`大模型（会议纪要 / 情绪分析）与 Orchisky CRM 同步。大模型当前：${configured ? `已配置（${activePreset?.label ?? "自定义"}）` : "未配置"}。`}
      />

      <section className="card u-p-5 u-flex u-col u-gap-4 set-form-card">
        <div className="u-row-between">
          <h3 className="form-section__title u-m-0">大模型（LLM）</h3>
          <Status tone={configured ? "moss" : "muted"}>{configured ? "已配置" : "未配置"}</Status>
        </div>

        <p className="meta u-m-0 u-fs-xs">
          支持任意 OpenAI 兼容接口。API Key 只保存在本机服务端（数据目录 config.json），不会上传，也不会在此页回显。
        </p>

        <FormRow label="提供商">
          <select className="field" value={provider} onChange={(e) => onPickProvider(e.target.value as ProviderKey)}>
            {PROVIDERS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </FormRow>

        <FormRow label="API Key">
          <Field
            type="password"
            placeholder={configured ? "已配置（留空则保持不变）" : "sk-..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </FormRow>

        <FormRow label="API Base（完整到 /v1）">
          <Field
            type="text"
            placeholder={activePreset && activePreset.base ? activePreset.base : "https://your-endpoint/v1"}
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
          />
        </FormRow>

        <FormRow label="模型">
          <Field
            type="text"
            placeholder={activePreset ? activePreset.modelPlaceholder : "model-name"}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </FormRow>

        <div className="u-cluster">
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
              className="u-mis-auto"
            >
              清除 Key
            </Button>
          )}
        </div>

        {error && <Diag code="SET_E">{error}</Diag>}
        {info && <Diag code="SET_OK" tone="info">{info}</Diag>}
      </section>

      <section className="card u-p-5 u-mt-5 u-flex u-col u-gap-4 set-form-card">
        <div className="u-row-between">
          <h3 className="form-section__title u-m-0">Orchisky CRM 同步</h3>
          <Status tone={settings.data?.crm_configured ? "moss" : "muted"}>
            {settings.data?.crm_configured ? "已配置" : "未配置"}
          </Status>
        </div>

        <p className="meta u-m-0 u-fs-xs">
          配置后，录音详情页可把会议纪要回写到 Orchisky CRM 并关联项目 / 商机。地址填到域名即可，导入 token 只存本机服务端、不回显。
        </p>

        <FormRow label="CRM 地址">
          <Field
            type="text"
            placeholder="https://your-crm-host"
            value={crmBase}
            onChange={(e) => setCrmBase(e.target.value)}
          />
        </FormRow>

        <FormRow label="导入 Token" hint="CRM 侧的 LOCAL_TRANSCRIPT_IMPORT_TOKEN。">
          <Field
            type="password"
            placeholder={settings.data?.crm_configured ? "已配置（留空则保持不变）" : "粘贴导入 token"}
            value={crmToken}
            onChange={(e) => setCrmToken(e.target.value)}
            autoComplete="off"
          />
        </FormRow>

        <div className="u-cluster">
          <Button
            variant="primary"
            size="sm"
            loading={saveCrm.isPending}
            onClick={() => { setCrmError(null); setCrmInfo(null); saveCrm.mutate(); }}
          >
            <Icon name="save" size={14} /> 保存
          </Button>
        </div>

        {crmError && <Diag code="CRM_SET_E">{crmError}</Diag>}
        {crmInfo && <Diag code="CRM_SET_OK" tone="info">{crmInfo}</Diag>}
      </section>

      <ConfirmDialog
        open={confirmClear}
        tone="danger"
        title="清除 API Key"
        body="确定清除 API Key？纪要相关功能将不可用，转写与声学情绪不受影响。"
        confirmText="清除"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => { setConfirmClear(false); setError(null); setInfo(null); clearKey.mutate(); }}
      />
    </div>
  );
}
