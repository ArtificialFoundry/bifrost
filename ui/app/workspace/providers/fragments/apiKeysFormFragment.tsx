import { ModelAccessSelector } from "@/components/modelAccess";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretVarInput } from "@/components/ui/secretVarInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TagInput } from "@/components/ui/tagInput";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { detectCredentialKind, hasCopilotApiToken, isOAuthExchangeCredential, isRedacted } from "@/lib/utils/validation";
import { useRefreshProviderModelsMutation, useUpdateProviderKeyMutation, useCreateProviderKeyMutation } from "@/lib/store/apis/providersApi";
import { githubCopilotKeyConfigComplete } from "@/lib/types/schemas";
import { getApiBaseUrl } from "@/lib/utils/port";
import { CheckCircle2, Copy, ExternalLink, Info, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Control, UseFormReturn } from "react-hook-form";
import { DeploymentsTable } from "./deploymentsTable";
import { toast } from "sonner";

// Providers that support batch APIs
const BATCH_SUPPORTED_PROVIDERS = ["openai", "bedrock", "anthropic", "gemini", "azure", "vertex", "wafer"];

// Providers that support live model refresh (dynamic model discovery)
const MODEL_REFRESH_PROVIDERS = ["copilot"];

/** True when the form's `key.value` carries either a literal token or an env-var reference. */
function hasTokenValue(v: { value?: string; env_var?: string } | undefined | null): boolean {
	return !!(v?.value || v?.env_var);
}

interface Props {
	control: Control<any>;
	providerName: string;
	// For custom providers, the underlying base provider type (e.g. "bedrock").
	// Drives which credential UI renders; falls back to providerName for native providers.
	baseProviderType?: string;
	form: UseFormReturn<any>;
	keyId?: string | null;
	createProviderKey?: ReturnType<typeof useCreateProviderKeyMutation>[0];
	onAutoCreated?: (newKeyId: string) => void;
}

// Batch API form field for all providers
function BatchAPIFormField({ control }: { control: Control<any>; form: UseFormReturn<any> }) {
	return (
		<FormField
			control={control}
			name={`key.use_for_batch_api`}
			render={({ field }) => (
				<FormItem className="flex flex-row items-center justify-between rounded-sm border p-2">
					<div className="space-y-1.5">
						<FormLabel>Use for Batch APIs</FormLabel>
						<FormDescription>
							Enable this key for batch API operations. Only keys with this enabled will be used for batch requests.
						</FormDescription>
					</div>
					<FormControl>
						<Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
					</FormControl>
				</FormItem>
			)}
		/>
	);
}

// AWS endpoint services Bifrost dials for Bedrock. `name` is the config field, `placeholder` the
// DNS name shape for that service - S3 differs from the rest, so each is spelled out.
const BEDROCK_VPC_ENDPOINT_SERVICES = [
	{
		name: "runtime",
		label: "Runtime",
		description: "Serves all inference.",
		placeholder: "vpce-0abc123-x1y2z3.bedrock-runtime.us-east-1.vpce.amazonaws.com",
	},
	{
		name: "control_plane",
		label: "Control Plane",
		description: "Serves model listing and batch jobs.",
		placeholder: "vpce-0abc123-x1y2z3.bedrock.us-east-1.vpce.amazonaws.com",
	},
	{
		name: "mantle",
		label: "Mantle",
		description: "Serves mantle-routed models.",
		placeholder: "vpce-0abc123-x1y2z3.bedrock-mantle.us-east-1.vpce.amazonaws.com",
	},
	{
		name: "agent_runtime",
		label: "Agent Runtime",
		description: "Serves rerank.",
		placeholder: "vpce-0abc123-x1y2z3.bedrock-agent-runtime.us-east-1.vpce.amazonaws.com",
	},
	{
		name: "s3",
		label: "S3",
		description: "Serves batch file I/O. Requires the bucket-prefixed endpoint name. A Gateway endpoint needs no value here.",
		placeholder: "bucket.vpce-0abc123-x1y2z3.s3.us-east-1.vpce.amazonaws.com",
	},
];

// VPC endpoint host overrides for AWS PrivateLink. Collapsed by default: most deployments reach
// Bedrock over the public regional endpoints and never set these.
function VPCEndpointsFormField({
	control,
	configKey,
	services,
}: {
	control: Control<any>;
	configKey: string;
	services: typeof BEDROCK_VPC_ENDPOINT_SERVICES;
}) {
	return (
		<Accordion type="single" collapsible className="w-full">
			<AccordionItem value="vpc-endpoints" className="rounded-sm border px-2 last:border-b">
				<AccordionTrigger className="py-2 hover:no-underline" data-testid="bedrock-vpc-endpoints-trigger">
					<span className="block space-y-1.5 pr-2">
						<span className="block text-sm leading-none font-medium">VPC Endpoints (Optional)</span>
						<span className="text-muted-foreground block text-sm font-normal">
							Route traffic through interface VPC endpoints instead of the public regional endpoints. Use each endpoint&apos;s DNS name from
							the VPC console, not its ID. Region is still required — it sets the request signing scope.
						</span>
					</span>
				</AccordionTrigger>
				<AccordionContent className="space-y-4 pt-2 pb-3">
					{services.map((service) => (
						<FormField
							key={service.name}
							control={control}
							name={`${configKey}.endpoints.${service.name}`}
							render={({ field }) => (
								<FormItem>
									<FormLabel>{service.label}</FormLabel>
									<FormDescription>{service.description}</FormDescription>
									<FormControl>
										<SecretVarInput
											data-testid={`apikey-bedrock-endpoint-${service.name}-input`}
											placeholder={service.placeholder}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					))}
				</AccordionContent>
			</AccordionItem>
		</Accordion>
	);
}


// Shared GitHub App (server-to-server) credential fields for GitHub Copilot. Used both by
// the legacy always-visible "github-copilot" provider block (custom-provider back-compat)
// and the "copilot" card's GitHub App auth tab (WBS 4.1 — ground-truth decision: fold
// github-copilot's capability into the copilot card rather than keep it a separate entry).
function GithubAppKeyConfigFields({ control, copilotAppSuffix }: { control: Control<any>; copilotAppSuffix: string }) {
	return (
		<>
					<FormField
						control={control}
						name="key.github_copilot_key_config.app_id"
						render={({ field }) => (
							<FormItem>
								<FormLabel>App ID {copilotAppSuffix}</FormLabel>
								<FormDescription>
									The GitHub App&apos;s App ID or Client ID, from its settings page.{" "}
									<a
										href="https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app"
										target="_blank"
										rel="noopener noreferrer"
										className="text-primary hover:underline"
										data-testid="copilot-docs-link-create-app"
									>
										Create a GitHub App
									</a>
								</FormDescription>
								<FormControl>
									<SecretVarInput data-testid="key-input-copilot-app-id" placeholder="123456 or env.COPILOT_APP_ID" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name="key.github_copilot_key_config.installation_id"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Installation ID {copilotAppSuffix}</FormLabel>
								<FormDescription>
									The installation on the organization that should be billed.{" "}
									<a
										href="https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app"
										target="_blank"
										rel="noopener noreferrer"
										className="text-primary hover:underline"
										data-testid="copilot-docs-link-installation-id"
									>
										Find your installation ID
									</a>
								</FormDescription>
								<FormControl>
									<SecretVarInput
										data-testid="key-input-copilot-installation-id"
										placeholder="87654321 or env.COPILOT_INSTALLATION_ID"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name="key.github_copilot_key_config.repository_id"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Repository ID {copilotAppSuffix}</FormLabel>
								<FormDescription>
									Any repository the installation can access. Copilot&apos;s permission check requires one in the token request even though
									the installation itself needs All repositories access, so this is not really a scoping choice.
								</FormDescription>
								<FormControl>
									<SecretVarInput
										data-testid="key-input-copilot-repository-id"
										placeholder="999000111 or env.COPILOT_REPOSITORY_ID"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name="key.github_copilot_key_config.private_key"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Private Key {copilotAppSuffix}</FormLabel>
								<FormDescription>
									The App&apos;s private key in PEM form, as downloaded from GitHub. PKCS#1 and PKCS#8 both work.
								</FormDescription>
								<FormControl>
									<SecretVarInput
										data-testid="key-input-copilot-private-key"
										variant="textarea"
										rows={4}
										placeholder="-----BEGIN RSA PRIVATE KEY----- or env.COPILOT_PRIVATE_KEY"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name="key.github_copilot_key_config.github_domain"
						render={({ field }) => (
							<FormItem>
								<FormLabel>GitHub Enterprise Domain (Optional)</FormLabel>
								<FormDescription>Leave blank for github.com</FormDescription>
								<FormControl>
									<SecretVarInput data-testid="key-input-copilot-github-domain" placeholder="acme.ghe.com" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
		</>
	);
}

export function ApiKeyFormFragment({ control, providerName, baseProviderType, form, keyId, createProviderKey, onAutoCreated }: Props) {
	// Credential UI keys off the base provider type for custom providers; the
	// model list, deployments table, and API calls still use the real providerName.
	const effectiveProvider = baseProviderType ?? providerName;
	const isBedrock = effectiveProvider === "bedrock";
	const isBedrockMantle = effectiveProvider === "bedrock_mantle";
	const isVertex = effectiveProvider === "vertex";
	const isAzure = effectiveProvider === "azure";
	const isReplicate = effectiveProvider === "replicate";
	const isVLLM = effectiveProvider === "vllm";
	const isOllama = effectiveProvider === "ollama";
	const isSGL = effectiveProvider === "sgl";
	const isDeepseek = effectiveProvider === "deepseek";
	const isFireworks = effectiveProvider === "fireworks";
	const isDatabricks = effectiveProvider === "databricks";
	// The "github-copilot" provider list entry is folded into the "copilot" card's third
	// auth tab (GitHub App) rather than rendered as its own always-visible block — see the
	// GitHub App tab inside CopilotDeviceLoginSection below. effectiveProvider can still be
	// "github-copilot" for a legacy/custom-provider config that points at it directly; that
	// case still needs the App-JWT fields, so isGithubCopilotLegacy keeps them available
	// without resurrecting the old hidden-provider UI path.
	const isGithubCopilotLegacy = effectiveProvider === "github-copilot";
	// Reactive, so the App-credential labels stay truthful. Once a Copilot token is present
	// those fields genuinely are optional, and a static "(Required)" would contradict the
	// section note telling the operator they can leave them blank.
	const copilotAppSuffix = hasCopilotApiToken(form.watch("key.value")) ? "(Optional)" : "(Required)";
	const isKeylessProvider = isOllama || isSGL;
	const supportsBatchAPI = BATCH_SUPPORTED_PROVIDERS.includes(effectiveProvider);
	const isCopilot = providerName === "copilot";
	const supportsModelRefresh = MODEL_REFRESH_PROVIDERS.includes(providerName);
	const [refreshModels, { isLoading: isRefreshingModels }] = useRefreshProviderModelsMutation();
	const [updateProviderKey] = useUpdateProviderKeyMutation();
	// For providers that support model refresh, enable the button only when a token
	// is available — either a freshly obtained local token (device-login / manual)
	// or a saved/redacted one from the server, OR complete GitHub App credentials (the
	// third auth tab authenticates without ever touching key.value).
	const copilotKeyValue = supportsModelRefresh ? form.watch('key.value') : undefined;
	const copilotAppConfig = supportsModelRefresh ? form.watch('key.github_copilot_key_config') : undefined;
	// Enable refresh when there's a literal token value OR an env-var reference (e.g. env.GITHUB_COPILOT_TOKEN)
	// OR a complete GitHub App credential set.
	const hasToken = hasTokenValue(copilotKeyValue) || githubCopilotKeyConfigComplete(copilotAppConfig);

	// Auth type state for Azure: 'api_key', 'entra_id', or 'default_credential'
	const [azureAuthType, setAzureAuthType] = useState<"api_key" | "entra_id" | "default_credential">("api_key");

	// Auth type state for Bedrock: 'iam_role', 'explicit', or 'api_key'
	const [bedrockAuthType, setBedrockAuthType] = useState<"iam_role" | "explicit" | "api_key">("iam_role");

	// Auth type state for Bedrock Mantle: 'iam_role', 'explicit', or 'api_key'
	const [bedrockMantleAuthType, setBedrockMantleAuthType] = useState<"iam_role" | "explicit" | "api_key">("iam_role");

	// Auth type state for Databricks: 'pat' (personal access token) or 'oauth_m2m' (service principal)
	const [databricksAuthType, setDatabricksAuthType] = useState<"pat" | "oauth_m2m">("pat");

	// Auth type state for Vertex: 'service_account', 'service_account_json', or 'api_key'
	const [vertexAuthType, setVertexAuthType] = useState<"service_account" | "service_account_json" | "api_key">("service_account");

	// Detect auth type from existing form values when editing
	useEffect(() => {
		if (form.formState.isDirty) return;
		if (isAzure) {
			const clientId = form.getValues("key.azure_key_config.client_id");
			const clientSecret = form.getValues("key.azure_key_config.client_secret");
			const tenantId = form.getValues("key.azure_key_config.tenant_id");
			const apiKey = form.getValues("key.value");
			const hasEntraField =
				clientId?.value || clientId?.ref || clientSecret?.value || clientSecret?.ref || tenantId?.value || tenantId?.ref;
			const hasApiKey = apiKey?.value || apiKey?.ref;
			let detected: "api_key" | "entra_id" | "default_credential" = "api_key";
			if (hasEntraField) {
				detected = "entra_id";
			} else if (!hasApiKey) {
				detected = "default_credential";
			}
			setAzureAuthType(detected);
			form.setValue("key.azure_key_config._auth_type", detected);
		}
	}, [isAzure, form]);

	useEffect(() => {
		if (form.formState.isDirty) return;
		if (isVertex) {
			const authCredentials = form.getValues("key.vertex_key_config.auth_credentials")?.value;
			const authCredentialsEnv = form.getValues("key.vertex_key_config.auth_credentials")?.ref;
			const apiKey = form.getValues("key.value")?.value;
			const apiKeyEnv = form.getValues("key.value")?.ref;
			let detected: "service_account" | "service_account_json" | "api_key" = "service_account";
			if (authCredentials || authCredentialsEnv) {
				detected = "service_account_json";
			} else if (apiKey || apiKeyEnv) {
				detected = "api_key";
			}
			setVertexAuthType(detected);
			form.setValue("key.vertex_key_config._auth_type", detected);
		}
	}, [isVertex, form]);

	const databricksDefaults = form.formState.defaultValues?.key?.databricks_key_config;
	useEffect(() => {
		if (form.formState.isDirty) return;
		if (isDatabricks) {
			const clientId = form.getValues("key.databricks_key_config.client_id");
			const clientSecret = form.getValues("key.databricks_key_config.client_secret");
			const hasServicePrincipal = clientId?.value || clientId?.ref || clientSecret?.value || clientSecret?.ref;
			const detected: "pat" | "oauth_m2m" = hasServicePrincipal ? "oauth_m2m" : "pat";
			setDatabricksAuthType(detected);
			form.setValue("key.databricks_key_config._auth_type", detected);
		}
		// databricksDefaults re-runs detection after the key form resets itself, which
		// happens once the key resolves - after this effect has already run once against
		// an empty form and settled on the personal access token tab.
	}, [isDatabricks, form, databricksDefaults]);

	useEffect(() => {
		if (form.formState.isDirty) return;
		if (isBedrock) {
			const accessKey = form.getValues("key.bedrock_key_config.access_key");
			const secretKey = form.getValues("key.bedrock_key_config.secret_key");
			const apiKey = form.getValues("key.value");
			const hasExplicitCreds = accessKey?.value || accessKey?.ref || secretKey?.value || secretKey?.ref;
			const hasApiKey = apiKey?.value || apiKey?.ref;
			let detected: "iam_role" | "explicit" | "api_key" = "iam_role";
			if (hasExplicitCreds) {
				detected = "explicit";
			} else if (hasApiKey) {
				detected = "api_key";
			}
			setBedrockAuthType(detected);
			form.setValue("key.bedrock_key_config._auth_type", detected);
		}
	}, [isBedrock, form]);

	useEffect(() => {
		if (form.formState.isDirty) return;
		if (isBedrockMantle) {
			const accessKey = form.getValues("key.bedrock_mantle_key_config.access_key");
			const secretKey = form.getValues("key.bedrock_mantle_key_config.secret_key");
			const apiKey = form.getValues("key.value");
			const hasExplicitCreds = accessKey?.value || accessKey?.ref || secretKey?.value || secretKey?.ref;
			const hasApiKey = apiKey?.value || apiKey?.ref;
			let detected: "iam_role" | "explicit" | "api_key" = "iam_role";
			if (hasExplicitCreds) {
				detected = "explicit";
			} else if (hasApiKey) {
				detected = "api_key";
			}
			setBedrockMantleAuthType(detected);
			form.setValue("key.bedrock_mantle_key_config._auth_type", detected);
		}
		// form.formState.defaultValues is a dependency so detection re-runs when ProviderKeyForm
		// repopulates an existing key via form.reset(...) after mount, not only on first render.
	}, [isBedrockMantle, form, form.formState.defaultValues]);

	// Copilot auth type state: 'device_login', 'manual_token', or 'github_app'.
	const [copilotAuthType, setCopilotAuthType] = useState<'device_login' | 'manual_token' | 'github_app'>('device_login')

	// Detect copilot auth type from existing form values when editing. GitHub App wins the
	// detection when its credentials are already complete — that's an unambiguous signal a
	// manual token round-trip can't produce, since the two auth modes are mutually exclusive
	// in practice (see the model-access gating note above for why hasToken now also checks
	// githubCopilotKeyConfigComplete).
	useEffect(() => {
		if (form.formState.isDirty) return
		if (isCopilot) {
			const appConfig = form.getValues('key.github_copilot_key_config')
			if (githubCopilotKeyConfigComplete(appConfig)) {
				setCopilotAuthType('github_app')
				return
			}
			const apiKey = form.getValues('key.value')?.value
			if (apiKey && !isRedacted(apiKey)) {
				setCopilotAuthType('manual_token')
			}
		}
	}, [isCopilot, form])

	// Copilot-only: controls the inline re-authenticate panel inside edit mode.
	const [showReauth, setShowReauth] = useState(false);
	const isEditing = keyId != null;
	const copilotAuthBlock = isCopilot ? (
		isEditing ? (
			<div className="space-y-3">
				<CopilotAuthStatusCard showReauth={showReauth} onToggleReauth={() => setShowReauth((s) => !s)} />
				{showReauth && (
					<>
						<Alert>
							<Info className="h-4 w-4" />
							<AlertDescription>Your current token stays active until the new authentication completes successfully.</AlertDescription>
						</Alert>
						<CopilotDeviceLoginSection
							control={control}
							form={form}
							copilotAuthType={copilotAuthType}
							setCopilotAuthType={setCopilotAuthType}
							providerName={providerName}
							keyId={keyId ?? null}
							updateProviderKey={updateProviderKey}
							refreshModels={refreshModels}
							createProviderKey={createProviderKey}
							onAutoCreated={onAutoCreated}
							onReauthComplete={() => setShowReauth(false)}
						/>
					</>
				)}
			</div>
		) : (
			<CopilotDeviceLoginSection
				control={control}
				form={form}
				copilotAuthType={copilotAuthType}
				setCopilotAuthType={setCopilotAuthType}
				providerName={providerName}
				keyId={keyId ?? null}
				updateProviderKey={updateProviderKey}
				refreshModels={refreshModels}
				createProviderKey={createProviderKey}
				onAutoCreated={(id) => {
					setShowReauth(false);
					onAutoCreated?.(id);
				}}
			/>
		)
	) : null;

	return (
		<div data-tab="api-keys" className="space-y-4 overflow-hidden">
			<div className="flex items-start gap-4">
				<div className="flex-1">
					<FormField
						control={control}
						name={`key.name`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Name</FormLabel>
								<FormControl>
									<Input placeholder="Production Key" type="text" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
				<FormField
					control={control}
					name={`key.weight`}
					render={({ field }) => (
						<FormItem>
							<div className="flex items-center gap-2">
								<FormLabel>Weight</FormLabel>
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												<Info className="text-muted-foreground h-3 w-3" />
											</span>
										</TooltipTrigger>
										<TooltipContent className="max-w-sm">
											<p>
												Determines traffic distribution between keys. Higher weights receive more requests. Not used when adaptive load
												balancing is enabled - key selection is then based on live performance.
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							</div>
							<FormControl>
								<Input
									placeholder="1.0"
									className="w-[260px]"
									value={field.value === undefined || field.value === null ? "" : String(field.value)}
									onChange={(e) => {
										// Keep as string during typing to allow partial input
										field.onChange(e.target.value === "" ? "" : e.target.value);
									}}
									onBlur={(e) => {
										const v = e.target.value.trim();
										if (v !== "") {
											const num = parseFloat(v);
											if (!isNaN(num)) {
												field.onChange(num);
											}
										}
										field.onBlur();
									}}
									name={field.name}
									ref={field.ref}
									type="text"
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
			</div>
			{copilotAuthBlock}
			{/* Hide API Key field for providers with dedicated auth tabs */}
			{!isAzure && !isBedrock && !isBedrockMantle && !isVertex && !isDatabricks && !(isCopilot && copilotAuthType !== 'manual_token') && (
				<FormField
					control={control}
					name={`key.value`}
					render={({ field }) => (
						<FormItem>
							<FormLabel>
								{isGithubCopilotLegacy ? "Copilot API Token" : "API Key"} {isVLLM || isGithubCopilotLegacy ? "(Optional)" : ""}
							</FormLabel>
							{isGithubCopilotLegacy && (
								<FormDescription>
									Requires Network Config &gt; Base URL set to the host the token was issued for, because a Copilot token does not carry
									one. Also expires after about 30 minutes, and Bifrost cannot refresh a token it did not mint, so prefer the GitHub App
									below for anything long-running.
								</FormDescription>
							)}
							<FormControl>
								<SecretVarInput
									placeholder={isGithubCopilotLegacy ? "Copilot API token, or leave blank to use a GitHub App" : "API Key or env.MY_KEY"}
									type="text"
									{...field}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
			)}
			{!isVLLM && (
				<div className={cn("space-y-4", isCopilot && !hasToken && "pointer-events-none opacity-50")} data-testid="model-access-block">
					{isCopilot && !hasToken && (
						<div
							className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-sm border border-dashed p-3 text-xs"
							data-testid="copilot-model-access-hint"
						>
							<Info className="size-3.5 shrink-0" />
							<span>Authenticate with GitHub above to configure model access for this key.</span>
						</div>
					)}
					<FormField
						control={control}
						name={`key.models`}
					render={({ field }) => (
						<FormItem>
							<FormControl>
								<ModelAccessSelector
									mode="allow"
									data-testid="api-keys-models-multiselect"
									provider={providerName}
									unfiltered
									value={field.value || []}
									onChange={field.onChange}
									label={
										<>
											<FormLabel>Allowed Models</FormLabel>
											<TooltipProvider>
												<Tooltip>
													<TooltipTrigger asChild>
														<span>
															<Info className="text-muted-foreground h-3 w-3" />
														</span>
													</TooltipTrigger>
													<TooltipContent className="max-w-sm">
														<p>
															Select specific models this key applies to, or choose "Allow All Models" to allow all. Leave empty to deny
															all. Aliases must be added by their alias name - listing only the underlying model does not allow the alias
															(an alias best-model → gpt-4o requires "best-model" here, not just "gpt-4o").
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</>
									}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={control}
					name={`key.blacklisted_models`}
					render={({ field }) => (
						<FormItem data-testid="apikey-blacklisted-models-field">
							<FormControl>
								<ModelAccessSelector
									mode="block"
									data-testid="api-keys-blocked-models-multiselect"
									provider={providerName}
									unfiltered
									value={field.value || []}
									onChange={field.onChange}
									label={
										<>
											<FormLabel>Blocked Models</FormLabel>
											<TooltipProvider>
												<Tooltip>
													<TooltipTrigger asChild>
														<span>
															<Info className="text-muted-foreground h-3 w-3" />
														</span>
													</TooltipTrigger>
													<TooltipContent className="max-w-sm">
														<p>
															Models this key must never serve. The denylist always wins - if a model appears in both Allowed Models and
															here, it is blocked. Select "All Models" to block every model on this key. Aliases are matched by their alias
															name - blocking only the underlying model does not block aliases that point to it.
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</>
									}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={control}
					name={`key.aliases`}
					render={({ field }) => (
						<FormItem data-testid="apikey-deployments-field">
							<FormLabel>Deployments (Optional)</FormLabel>
							<FormDescription>
								Map a request model name to the provider&apos;s identifier (deployment name, inference profile ID, etc.). Expand a row for
								canonical name, model family, and provider overrides - these drive cost logs and family-based routing.
								{isReplicate && (
									<>
										{" "}
										Replicate deployments are listed only while &quot;Use Deployments Endpoint&quot; is on - otherwise type the owner/name
										and press Enter.
									</>
								)}
							</FormDescription>
							<FormControl>
								<div data-testid="apikey-deployments-table">
									<DeploymentsTable
										providerName={providerName}
										value={field.value}
										onChange={(next) => {
											form.clearErrors("key.aliases");
											field.onChange(Object.keys(next).length > 0 ? next : {});
										}}
									/>
								</div>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				</div>
			)}
			{supportsBatchAPI && !isBedrock && !isAzure && !isVertex && <BatchAPIFormField control={control} form={form} />}
			{isAzure && (
				<div className="space-y-4">
					<Separator className="my-6" />
					<div className="space-y-2">
						<FormLabel>Authentication Method</FormLabel>
						<Tabs
							value={azureAuthType}
							onValueChange={(v) => {
								setAzureAuthType(v as "api_key" | "entra_id" | "default_credential");
								form.setValue("key.azure_key_config._auth_type", v, { shouldDirty: true, shouldValidate: true });
								if (v === "entra_id" || v === "default_credential") {
									// Clear API key when switching away from API Key
									form.setValue("key.value", undefined, { shouldDirty: true });
								}
								if (v === "api_key" || v === "default_credential") {
									// Clear Entra ID fields when switching away from Entra ID
									form.setValue("key.azure_key_config.client_id", undefined, { shouldDirty: true });
									form.setValue("key.azure_key_config.client_secret", undefined, { shouldDirty: true });
									form.setValue("key.azure_key_config.tenant_id", undefined, { shouldDirty: true });
									form.setValue("key.azure_key_config.scopes", undefined, { shouldDirty: true });
								}
							}}
						>
							<TabsList className="flex w-full justify-start">
								<TabsTrigger data-testid="apikey-azure-default-credential-tab" value="default_credential">
									Default Credential
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-azure-api-key-tab" value="api_key">
									API Key
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-azure-entra-id-tab" value="entra_id">
									Entra ID (Service Principal)
								</TabsTrigger>
							</TabsList>
						</Tabs>
					</div>
					{azureAuthType === "api_key" && (
						<FormField
							control={control}
							name={`key.value`}
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										API Key {isVertex ? "(Supported only for gemini and fine-tuned models)" : isVLLM ? "(Optional)" : ""}
									</FormLabel>
									<FormControl>
										<SecretVarInput placeholder="API Key or env.MY_KEY" type="text" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					{azureAuthType === "default_credential" && (
						<p className="text-muted-foreground text-sm">
							Uses DefaultAzureCredential - automatically detects managed identity on Azure VMs and containers, workload identity in AKS,
							environment variables, and Azure CLI. No credentials required.
						</p>
					)}

					<FormField
						control={control}
						name={`key.azure_key_config.endpoint`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Endpoint (Required)</FormLabel>
								<FormControl>
									<SecretVarInput placeholder="https://your-resource.openai.azure.com or env.AZURE_ENDPOINT" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					{azureAuthType === "entra_id" && (
						<>
							<FormField
								control={control}
								name={`key.azure_key_config.client_id`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Client ID (Required)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-client-id or env.AZURE_CLIENT_ID" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.azure_key_config.client_secret`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Client Secret (Required)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-client-secret or env.AZURE_CLIENT_SECRET" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.azure_key_config.tenant_id`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Tenant ID (Required)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-tenant-id or env.AZURE_TENANT_ID" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.azure_key_config.scopes`}
								render={({ field }) => (
									<FormItem>
										<div className="flex items-center gap-2">
											<FormLabel>Scopes (Optional)</FormLabel>
											<TooltipProvider>
												<Tooltip>
													<TooltipTrigger asChild>
														<span>
															<Info className="text-muted-foreground h-3 w-3" />
														</span>
													</TooltipTrigger>
													<TooltipContent>
														<p>
															Optional OAuth scopes for token requests. By default we use https://cognitiveservices.azure.com/.default - add
															additional scopes here if your setup requires extra permissions.
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</div>
										<FormControl>
											<TagInput
												data-testid="apikey-azure-scopes-input"
												placeholder="Add scope (Enter or comma)"
												value={field.value ?? []}
												onValueChange={field.onChange}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}
					{supportsBatchAPI && <BatchAPIFormField control={control} form={form} />}
				</div>
			)}
			{isVertex && (
				<div className="space-y-4">
					<Separator className="my-6" />
					<div className="space-y-2">
						<FormLabel>Authentication Method</FormLabel>
						<Tabs
							value={vertexAuthType}
							onValueChange={(v) => {
								setVertexAuthType(v as "service_account" | "service_account_json" | "api_key");
								form.setValue("key.vertex_key_config._auth_type", v, { shouldDirty: true, shouldValidate: true });
								if (v === "service_account" || v === "api_key") {
									// Clear auth credentials when switching away from service account JSON
									form.setValue("key.vertex_key_config.auth_credentials", undefined, { shouldDirty: true });
								}
								if (v === "service_account" || v === "service_account_json") {
									// Clear API key when switching away from API Key
									form.setValue("key.value", undefined, { shouldDirty: true });
								}
							}}
						>
							<TabsList className="flex w-full justify-start">
								<TabsTrigger data-testid="apikey-vertex-service-account-tab" value="service_account">
									Service Account (Attached)
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-vertex-service-account-json-tab" value="service_account_json">
									Service Account (JSON)
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-vertex-api-key-tab" value="api_key">
									API Key
								</TabsTrigger>
							</TabsList>
						</Tabs>
						{vertexAuthType === "service_account" && (
							<p className="text-muted-foreground text-sm">
								Uses the service account attached to your environment (GCE, GKE, Cloud Run). No credentials required.
							</p>
						)}
					</div>

					<FormField
						control={control}
						name={`key.vertex_key_config.project_id`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Project ID (Required)</FormLabel>
								<FormControl>
									<SecretVarInput placeholder="your-gcp-project-id or env.VERTEX_PROJECT_ID" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name={`key.vertex_key_config.project_number`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Project Number (Required only for fine-tuned models)</FormLabel>
								<FormControl>
									<SecretVarInput placeholder="your-gcp-project-number or env.VERTEX_PROJECT_NUMBER" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name={`key.vertex_key_config.region`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Region (Required)</FormLabel>
								<FormDescription>
									Multi-region-only models are automatically routed to Google&apos;s matching multi-region endpoint. Turn on{" "}
									<span className="font-medium">Force single region</span> below to always use exactly this region.
								</FormDescription>
								<FormControl>
									<SecretVarInput placeholder="us-central1 or env.VERTEX_REGION" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					{vertexAuthType === "service_account_json" && (
						<FormField
							control={control}
							name={`key.vertex_key_config.auth_credentials`}
							render={({ field }) => (
								<FormItem>
									<FormLabel>Auth Credentials (Required)</FormLabel>
									<FormDescription>Service account JSON object or env.VAR_NAME</FormDescription>
									<FormControl>
										<SecretVarInput
											data-testid="apikey-vertex-auth-credentials-input"
											variant="textarea"
											rows={4}
											placeholder='{"type":"service_account","project_id":"your-gcp-project",...} or env.VERTEX_CREDENTIALS'
											inputClassName="font-mono text-sm"
											{...field}
										/>
									</FormControl>
									{isRedacted(field.value?.value ?? "") && (
										<div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
											<Info className="h-3 w-3" />
											<span>Credentials are stored securely. Edit to update.</span>
										</div>
									)}
									<FormMessage />
								</FormItem>
							)}
						/>
					)}

					{vertexAuthType === "api_key" && (
						<FormField
							control={control}
							name={`key.value`}
							render={({ field }) => (
								<FormItem>
									<FormLabel>API Key (Supported only for gemini and fine-tuned models)</FormLabel>
									<FormControl>
										<SecretVarInput data-testid="apikey-vertex-api-key-input" placeholder="API Key or env.MY_KEY" type="text" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					<FormField
						control={control}
						name="key.vertex_key_config.force_single_region"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between rounded-sm border p-2">
								<div className="space-y-1.5">
									<FormLabel>Force single region</FormLabel>
									<FormDescription>
										Always call the region set above and skip automatic promotion of multi-region-only models to a multi-region endpoint.
										Enable when serving these models from a single region via provisioned throughput.
									</FormDescription>
								</div>
								<FormControl>
									<Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
								</FormControl>
							</FormItem>
						)}
					/>
					{supportsBatchAPI && <BatchAPIFormField control={control} form={form} />}
				</div>
			)}
			{isReplicate && (
				<div className="space-y-4">
					<Separator className="my-6" />
					<FormField
						control={control}
						name="key.replicate_key_config.use_deployments_endpoint"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between rounded-sm border p-2">
								<div className="space-y-1.5">
									<FormLabel>Use Deployments Endpoint</FormLabel>
									<FormDescription>
										Sends <strong>every</strong> model on this key to /v1/deployments/&#123;owner&#125;/&#123;name&#125;/predictions, so
										plain model names stop working. To switch just one model, leave this off and set &quot;Use deployments endpoint&quot; on
										its row above.
									</FormDescription>
									<FormMessage />
								</div>
								<FormControl>
									<Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
								</FormControl>
							</FormItem>
						)}
					/>
				</div>
			)}
			{isVLLM && (
				<div className="space-y-4">
					<Separator className="my-6" />
					<FormField
						control={control}
						name="key.vllm_key_config.url"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Server URL (Required)</FormLabel>
								<FormDescription>Base URL of the vLLM server (e.g. http://vllm-server:8000 or env.VLLM_URL)</FormDescription>
								<FormControl>
									<SecretVarInput data-testid="key-input-vllm-url" placeholder="http://vllm-server:8000" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name="key.vllm_key_config.model_name"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Model Name (Required)</FormLabel>
								<FormDescription>Exact model name served on this vLLM instance</FormDescription>
								<FormControl>
									<Input data-testid="key-input-vllm-model-name" placeholder="meta-llama/Llama-3-70b-hf" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
			)}
			{isDatabricks && (
				<div className="space-y-4">
					<FormField
						control={control}
						name="key.databricks_key_config.workspace_url"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Workspace URL (Required)</FormLabel>
								<FormDescription>
									Your Databricks workspace URL (e.g. https://dbc-1234abcd-5678.cloud.databricks.com or env.DATABRICKS_WORKSPACE_URL)
								</FormDescription>
								<FormControl>
									<SecretVarInput
										data-testid="key-input-databricks-workspace-url"
										placeholder="https://dbc-1234abcd-5678.cloud.databricks.com"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name="key.databricks_key_config.api_format"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Inference Surface</FormLabel>
								<FormDescription>
									Auto picks by model name: a dotted name such as system.ai.claude-sonnet-4-5 goes to the Unity AI Gateway, anything else to
									Model Serving. Choose explicitly to pin one surface.
								</FormDescription>
								<Select value={field.value ?? "auto"} onValueChange={field.onChange}>
									<FormControl>
										<SelectTrigger data-testid="key-select-databricks-api-format">
											<SelectValue placeholder="Auto" />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										<SelectItem value="auto">Auto (by model name)</SelectItem>
										<SelectItem value="model_serving">Model Serving (/serving-endpoints)</SelectItem>
										<SelectItem value="ai_gateway">Unity AI Gateway (/ai-gateway/mlflow/v1)</SelectItem>
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>
					<Separator className="my-6" />
					<div className="space-y-2">
						<FormLabel>Authentication Method</FormLabel>
						<Tabs
							value={databricksAuthType}
							onValueChange={(v) => {
								setDatabricksAuthType(v as "pat" | "oauth_m2m");
								form.setValue("key.databricks_key_config._auth_type", v, { shouldDirty: true, shouldValidate: true });
								if (v === "oauth_m2m") {
									// The token and the service principal are alternatives, never both.
									form.setValue("key.value", undefined, { shouldDirty: true });
								} else {
									form.setValue("key.databricks_key_config.client_id", undefined, { shouldDirty: true });
									form.setValue("key.databricks_key_config.client_secret", undefined, { shouldDirty: true });
								}
							}}
						>
							<TabsList className="grid w-full grid-cols-2">
								<TabsTrigger data-testid="apikey-databricks-pat-tab" value="pat">
									Personal Access Token
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-databricks-oauth-tab" value="oauth_m2m">
									OAuth M2M (Service Principal)
								</TabsTrigger>
							</TabsList>
						</Tabs>
					</div>
					{databricksAuthType === "pat" && (
						<FormField
							control={control}
							name="key.value"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Personal Access Token</FormLabel>
									<FormDescription>Generate one from Settings &gt; Developer &gt; Access tokens in your workspace.</FormDescription>
									<FormControl>
										<SecretVarInput
											data-testid="key-input-databricks-pat"
											placeholder="dapi... or env.DATABRICKS_TOKEN"
											type="text"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					{databricksAuthType === "oauth_m2m" && (
						<>
							<p className="text-muted-foreground text-sm">
								Databricks recommends OAuth machine-to-machine for production. Tokens are minted from the workspace OIDC endpoint and
								refreshed automatically.
							</p>
							<FormField
								control={control}
								name="key.databricks_key_config.client_id"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Client ID</FormLabel>
										<FormControl>
											<SecretVarInput
												data-testid="key-input-databricks-client-id"
												placeholder="Service principal client ID or env.DATABRICKS_CLIENT_ID"
												type="text"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name="key.databricks_key_config.client_secret"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Client Secret</FormLabel>
										<FormControl>
											<SecretVarInput
												data-testid="key-input-databricks-client-secret"
												placeholder="Service principal secret or env.DATABRICKS_CLIENT_SECRET"
												type="text"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}
					<FormField
						control={control}
						name="key.databricks_key_config.forward_gateway_tags"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between rounded-sm border p-2">
								<div className="space-y-1.5">
									<FormLabel htmlFor="databricks-forward-gateway-tags-switch">Forward Governance Tags</FormLabel>
									<FormDescription>
										Sends the virtual key, team and customer names as Databricks-Ai-Gateway-Request-Tags, so Databricks usage tracking
										attributes spend the same way Bifrost does. Names only, never user identifiers.
									</FormDescription>
								</div>
								<FormControl>
									<Switch id="databricks-forward-gateway-tags-switch" checked={field.value ?? false} onCheckedChange={field.onChange} />
								</FormControl>
							</FormItem>
						)}
					/>
				</div>
			)}
			{isKeylessProvider && (
				<div className="space-y-4">
					<FormField
						control={control}
						name={`key.${isOllama ? "ollama_key_config" : "sgl_key_config"}.url`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Server URL (Required)</FormLabel>
								<FormDescription>
									Base URL of the {isOllama ? "Ollama" : "SGLang"} server (e.g.{" "}
									{isOllama ? "http://localhost:11434" : "http://localhost:30000"} or {isOllama ? "env.OLLAMA_URL" : "env.SGL_URL"})
								</FormDescription>
								<FormControl>
									<SecretVarInput
										data-testid={`key-input-${isOllama ? "ollama" : "sgl"}-url`}
										placeholder={isOllama ? "http://localhost:11434" : "http://localhost:30000"}
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
			)}
			{isGithubCopilotLegacy && (
				<div className="space-y-4">
					<Separator />
					<div className="bg-muted/50 flex items-start gap-2 rounded-md border p-3">
						<Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
						<p className="text-muted-foreground text-sm">
							Copilot accepts either credential. Fill in <strong>one</strong> of the two. <strong>GitHub App</strong> is the option for a
							shared gateway: usage bills to the organization that owns the installation and no individual Copilot seat is used. A{" "}
							<strong>Copilot API token</strong> in the field above is simpler but expires after about 30 minutes, so it suits testing
							rather than a running gateway.{" "}
							<a
								href="https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens"
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:underline"
								data-testid="copilot-docs-link-server-to-server"
							>
								Set up a GitHub App for Copilot
							</a>
							{" or "}
							<a
								href="https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk"
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:underline"
								data-testid="copilot-docs-link-api-token"
							>
								get a Copilot API token
							</a>
							.
						</p>
					</div>
					<div className="space-y-1.5">
						{/* Label, not FormLabel: this heads a section rather than labelling one
						    control, so there is no FormItem id for htmlFor to point at. */}
						<Label>GitHub App Credentials</Label>
						<p className="text-muted-foreground text-sm">
							Leave these blank if you supplied a Copilot API token above. Otherwise all four are needed together. The App needs the Copilot
							Requests permission at Read &amp; write, installed on the organization that should be billed with All repositories access, and
							that organization must allow Copilot requests from GitHub App installations.
						</p>
					</div>
					<GithubAppKeyConfigFields control={control} copilotAppSuffix={copilotAppSuffix} />
				</div>
			)}
			{(isSGL || isDeepseek || isFireworks || isVLLM) && (
				<div className="space-y-4">
					<FormField
						control={control}
						name="key.use_anthropic_endpoints"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between rounded-sm border p-2">
								<div className="space-y-1.5">
									<FormLabel htmlFor="use-anthropic-endpoints-alias-override-switch">Use Anthropic Endpoints</FormLabel>
									<FormDescription>Routes chat completions and responses requests through Anthropic-compatible endpoints.</FormDescription>
								</div>
								<FormControl>
									<Switch
										id="use-anthropic-endpoints-alias-override-switch"
										checked={field.value ?? false}
										onCheckedChange={field.onChange}
									/>
								</FormControl>
							</FormItem>
						)}
					/>
				</div>
			)}
			{isBedrock && (
				<div className="space-y-4">
					<FormField
						control={control}
						name="key.use_openai_endpoints"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between rounded-sm border p-2">
								<div className="space-y-1.5">
									<FormLabel htmlFor="use-openai-endpoints-switch">Use OpenAI Endpoints</FormLabel>
									<FormDescription>Routes requests through Bedrock&apos;s OpenAI-compatible endpoints instead of Converse.</FormDescription>
								</div>
								<FormControl>
									<Switch
										id="use-openai-endpoints-switch"
										data-testid="key-switch-bedrock-use-openai-endpoints"
										checked={field.value ?? false}
										onCheckedChange={field.onChange}
									/>
								</FormControl>
							</FormItem>
						)}
					/>
					<Separator className="my-6" />
					<div className="space-y-2">
						<FormLabel>Authentication Method</FormLabel>
						<Tabs
							value={bedrockAuthType}
							onValueChange={(v) => {
								setBedrockAuthType(v as "iam_role" | "explicit" | "api_key");
								form.setValue("key.bedrock_key_config._auth_type", v, { shouldDirty: true, shouldValidate: true });
								if (v === "iam_role") {
									// Clear explicit credentials and API key when switching to IAM Role
									form.setValue("key.bedrock_key_config.access_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_key_config.secret_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_key_config.session_token", undefined, { shouldDirty: true });
									form.setValue("key.value", undefined, { shouldDirty: true });
								} else if (v === "explicit") {
									// Clear API key when switching to Explicit Credentials
									form.setValue("key.value", undefined, { shouldDirty: true });
								} else if (v === "api_key") {
									// Clear AWS credentials and assume-role fields when switching to API Key
									form.setValue("key.bedrock_key_config.access_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_key_config.secret_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_key_config.session_token", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_key_config.role_arn", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_key_config.external_id", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_key_config.session_name", undefined, { shouldDirty: true });
								}
							}}
						>
							<TabsList className="flex w-full justify-start">
								<TabsTrigger data-testid="apikey-bedrock-iam-role-tab" value="iam_role">
									IAM Role (Inherited)
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-bedrock-explicit-credentials-tab" value="explicit">
									Explicit Credentials
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-bedrock-api-key-tab" value="api_key">
									API Key
								</TabsTrigger>
							</TabsList>
						</Tabs>
						{bedrockAuthType === "iam_role" && (
							<p className="text-muted-foreground text-sm">Uses IAM roles attached to your environment (EC2, Lambda, ECS, EKS).</p>
						)}
						{bedrockAuthType === "api_key" && (
							<p className="text-muted-foreground text-sm">Uses a Bearer token for API key authentication.</p>
						)}
					</div>

					{bedrockAuthType === "explicit" && (
						<>
							<FormField
								control={control}
								name={`key.bedrock_key_config.access_key`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Access Key (Required)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-aws-access-key or env.AWS_ACCESS_KEY_ID" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_key_config.secret_key`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Secret Key (Required)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-aws-secret-key or env.AWS_SECRET_ACCESS_KEY" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_key_config.session_token`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Session Token (Optional)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-aws-session-token or env.AWS_SESSION_TOKEN" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}

					{bedrockAuthType === "api_key" && (
						<FormField
							control={control}
							name={`key.value`}
							render={({ field }) => (
								<FormItem>
									<FormLabel>API Key</FormLabel>
									<FormControl>
										<SecretVarInput
											data-testid="apikey-bedrock-api-key-input"
											placeholder="API Key or env.BEDROCK_API_KEY"
											type="text"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}

					<FormField
						control={control}
						name={`key.bedrock_key_config.region`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Region (Required)</FormLabel>
								<FormControl>
									<SecretVarInput placeholder="us-east-1 or env.AWS_REGION" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name={`key.bedrock_key_config.project_id`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Mantle Project ID (Optional)</FormLabel>
								<FormDescription>
									Scopes Bedrock Mantle-routed models (OpenAI-family / Gemma) to a specific project via the OpenAI-Project header. Leave
									empty to use the account&apos;s default project.
								</FormDescription>
								<FormControl>
									<SecretVarInput
										data-testid="apikey-bedrock-project-id-input"
										placeholder="proj_xxxxxxxx or env.BEDROCK_PROJECT_ID"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					{bedrockAuthType !== "api_key" && (
						<>
							<FormField
								control={control}
								name={`key.bedrock_key_config.role_arn`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Assume Role ARN (Optional)</FormLabel>
										<FormDescription>
											Assume an IAM role before requests. Works with both explicit credentials and inherited IAM (EC2, ECS, EKS).
										</FormDescription>
										<FormControl>
											<SecretVarInput
												data-testid="apikey-bedrock-role-arn-input"
												placeholder="arn:aws:iam::123456789:role/MyRole or env.AWS_ROLE_ARN"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_key_config.external_id`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>External ID (Optional)</FormLabel>
										<FormDescription>Required by the role's trust policy when using cross-account access</FormDescription>
										<FormControl>
											<SecretVarInput
												data-testid="apikey-bedrock-external-id-input"
												placeholder="external-id or env.AWS_EXTERNAL_ID"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_key_config.session_name`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Session Name (Optional)</FormLabel>
										<FormDescription>AssumeRole session name (defaults to bifrost-session)</FormDescription>
										<FormControl>
											<SecretVarInput
												data-testid="apikey-bedrock-session-name-input"
												placeholder="bifrost-session or env.AWS_SESSION_NAME"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}
					<FormField
						control={control}
						name={`key.bedrock_key_config.arn`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>ARN (Optional)</FormLabel>
								<FormControl>
									<SecretVarInput placeholder="arn:aws:bedrock:us-east-1:123:inference-profile or env.AWS_ARN" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					{supportsBatchAPI && (
						<FormField
							control={control}
							name={`key.bedrock_key_config.batch_role_arn`}
							render={({ field }) => (
								<FormItem>
									<FormLabel>Batch Role ARN (Optional)</FormLabel>
									<FormDescription>
										Service role Bedrock assumes for batch S3 access. When set, it takes priority over the role_arn sent in requests.
									</FormDescription>
									<FormControl>
										<SecretVarInput
											data-testid="apikey-bedrock-batch-role-arn-input"
											placeholder="arn:aws:iam::123456789:role/BatchRole or env.AWS_BATCH_ROLE_ARN"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					{supportsBatchAPI && <BatchAPIFormField control={control} form={form} />}
					<VPCEndpointsFormField control={control} configKey="key.bedrock_key_config" services={BEDROCK_VPC_ENDPOINT_SERVICES} />
				</div>
			)}

			{isBedrockMantle && (
				<div className="space-y-4">
					<Separator className="my-6" />
					<div className="space-y-2">
						<FormLabel>Authentication Method</FormLabel>
						<Tabs
							value={bedrockMantleAuthType}
							onValueChange={(v) => {
								setBedrockMantleAuthType(v as "iam_role" | "explicit" | "api_key");
								form.setValue("key.bedrock_mantle_key_config._auth_type", v, { shouldDirty: true, shouldValidate: true });
								if (v === "iam_role") {
									// Clear explicit credentials and API key when switching to IAM Role
									form.setValue("key.bedrock_mantle_key_config.access_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_mantle_key_config.secret_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_mantle_key_config.session_token", undefined, { shouldDirty: true });
									form.setValue("key.value", undefined, { shouldDirty: true });
								} else if (v === "explicit") {
									// Clear API key when switching to Explicit Credentials
									form.setValue("key.value", undefined, { shouldDirty: true });
								} else if (v === "api_key") {
									// Clear AWS credentials and assume-role fields when switching to API Key
									form.setValue("key.bedrock_mantle_key_config.access_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_mantle_key_config.secret_key", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_mantle_key_config.session_token", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_mantle_key_config.role_arn", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_mantle_key_config.external_id", undefined, { shouldDirty: true });
									form.setValue("key.bedrock_mantle_key_config.session_name", undefined, { shouldDirty: true });
								}
							}}
						>
							<TabsList className="flex w-full justify-start">
								<TabsTrigger data-testid="apikey-bedrock-mantle-iam-role-tab" value="iam_role">
									IAM Role (Inherited)
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-bedrock-mantle-explicit-credentials-tab" value="explicit">
									Explicit Credentials
								</TabsTrigger>
								<TabsTrigger data-testid="apikey-bedrock-mantle-api-key-tab" value="api_key">
									API Key
								</TabsTrigger>
							</TabsList>
						</Tabs>
						{bedrockMantleAuthType === "iam_role" && (
							<p className="text-muted-foreground text-sm">Uses IAM roles attached to your environment (EC2, Lambda, ECS, EKS).</p>
						)}
						{bedrockMantleAuthType === "api_key" && (
							<p className="text-muted-foreground text-sm">Uses a Bedrock Mantle API key sent as a Bearer token.</p>
						)}
					</div>

					{bedrockMantleAuthType === "explicit" && (
						<>
							<FormField
								control={control}
								name={`key.bedrock_mantle_key_config.access_key`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Access Key (Required)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-aws-access-key or env.AWS_ACCESS_KEY_ID" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_mantle_key_config.secret_key`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Secret Key (Required)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-aws-secret-key or env.AWS_SECRET_ACCESS_KEY" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_mantle_key_config.session_token`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Session Token (Optional)</FormLabel>
										<FormControl>
											<SecretVarInput placeholder="your-aws-session-token or env.AWS_SESSION_TOKEN" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}

					{bedrockMantleAuthType === "api_key" && (
						<FormField
							control={control}
							name={`key.value`}
							render={({ field }) => (
								<FormItem>
									<FormLabel>API Key</FormLabel>
									<FormControl>
										<SecretVarInput
											data-testid="apikey-bedrock-mantle-api-key-input"
											placeholder="API Key or env.BEDROCK_MANTLE_API_KEY"
											type="text"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}

					<FormField
						control={control}
						name={`key.bedrock_mantle_key_config.region`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Region (Required)</FormLabel>
								<FormControl>
									<SecretVarInput placeholder="us-east-1 or env.AWS_REGION" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					<FormField
						control={control}
						name={`key.bedrock_mantle_key_config.project_id`}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Project ID (Optional)</FormLabel>
								<FormDescription>
									Scopes inference and model listing to a specific Bedrock project (sent as the OpenAI-Project / anthropic-workspace-id
									header). Leave empty to use the account&apos;s default project.
								</FormDescription>
								<FormControl>
									<SecretVarInput
										data-testid="apikey-bedrock-mantle-project-id-input"
										placeholder="proj_xxxxxxxx or env.BEDROCK_PROJECT_ID"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					{bedrockMantleAuthType !== "api_key" && (
						<>
							<FormField
								control={control}
								name={`key.bedrock_mantle_key_config.role_arn`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Assume Role ARN (Optional)</FormLabel>
										<FormDescription>
											Assume an IAM role before requests. Works with both explicit credentials and inherited IAM (EC2, ECS, EKS).
										</FormDescription>
										<FormControl>
											<SecretVarInput placeholder="arn:aws:iam::123456789:role/MyRole or env.AWS_ROLE_ARN" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_mantle_key_config.external_id`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>External ID (Optional)</FormLabel>
										<FormDescription>Required by the role&apos;s trust policy when using cross-account access.</FormDescription>
										<FormControl>
											<SecretVarInput placeholder="external-id or env.AWS_EXTERNAL_ID" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={control}
								name={`key.bedrock_mantle_key_config.session_name`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>Session Name (Optional)</FormLabel>
										<FormDescription>AssumeRole session name (defaults to bifrost-session).</FormDescription>
										<FormControl>
											<SecretVarInput placeholder="bifrost-session or env.AWS_SESSION_NAME" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}
					<VPCEndpointsFormField
						control={control}
						configKey="key.bedrock_mantle_key_config"
						services={BEDROCK_VPC_ENDPOINT_SERVICES.filter((s) => s.name === "mantle")}
					/>
				</div>
			)}
		</div>
	);
}
function CopilotAuthStatusCard({ showReauth, onToggleReauth }: { showReauth: boolean; onToggleReauth: () => void }) {
	return (
		<div className="bg-muted/40 rounded-sm border p-4" data-testid="copilot-auth-status-card">
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-3">
					<CheckCircle2 className="text-primary mt-0.5 size-5 shrink-0" />
					<div>
						<p className="text-sm font-medium">Authenticated with GitHub</p>
						<p className="text-muted-foreground mt-0.5 text-xs">
							Token saved. {showReauth ? "Complete the flow below to replace it." : "Re-authenticate to swap the token without downtime."}
						</p>
					</div>
				</div>
				<Button type="button" variant="outline" size="sm" onClick={onToggleReauth} data-testid="copilot-reauth-toggle">
					{showReauth ? "Cancel" : "Re-authenticate"}
				</Button>
			</div>
		</div>
	);
}

function CopilotDeviceLoginSection({
	control,
	form,
	copilotAuthType,
	setCopilotAuthType,
	providerName,
	keyId,
	updateProviderKey,
	refreshModels,
	createProviderKey,
	onAutoCreated,
	onReauthComplete,
}: {
	control: Control<any>;
	form: UseFormReturn<any>;
	copilotAuthType: 'device_login' | 'manual_token' | 'github_app';
	setCopilotAuthType: (v: 'device_login' | 'manual_token' | 'github_app') => void;
	providerName: string;
	keyId: string | null;
	updateProviderKey: ReturnType<typeof useUpdateProviderKeyMutation>[0];
	refreshModels: ReturnType<typeof useRefreshProviderModelsMutation>[0];
	createProviderKey?: ReturnType<typeof useCreateProviderKeyMutation>[0];
	onAutoCreated?: (newKeyId: string) => void;
	onReauthComplete?: () => void;
}) {
	const [deviceState, setDeviceState] = useState<{
		status: 'idle' | 'awaiting_auth' | 'complete' | 'error';
		userCode?: string;
		verificationUri?: string;
		deviceCode?: string;
		interval?: number;
		error?: string;
	}>({ status: 'idle' });

	const [copied, setCopied] = useState(false);
	const [countdown, setCountdown] = useState<number | null>(null);
	const [isChecking, setIsChecking] = useState(false);
	const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const authTypeRef = useRef(copilotAuthType);
	const pollSessionRef = useRef(0);

	useEffect(() => {
		authTypeRef.current = copilotAuthType;
	}, [copilotAuthType]);

	const clearCountdown = useCallback(() => {
		if (countdownRef.current) {
			clearInterval(countdownRef.current);
			countdownRef.current = null;
		}
		setCountdown(null);
	}, []);

	// Clean up on unmount
	useEffect(() => {
		return () => {
			if (countdownRef.current) clearInterval(countdownRef.current);
		};
	}, []);

	const invalidatePolling = useCallback(() => {
		pollSessionRef.current += 1;
	}, []);

	const initiateLogin = useCallback(async () => {
		invalidatePolling();
		setDeviceState({ status: 'awaiting_auth' });
		try {
			const baseUrl = getApiBaseUrl();
			const resp = await fetch(`${baseUrl}/providers/copilot/device-login/initiate`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
			});
			if (!resp.ok) {
				const errData = await resp.json().catch(() => ({ error: { message: resp.statusText } }));
				setDeviceState({ status: 'error', error: errData?.error?.message || 'Failed to start device login' });
				return;
			}
			const data = await resp.json();
			setDeviceState({
				status: 'awaiting_auth',
				userCode: data.user_code,
				verificationUri: data.verification_uri,
				deviceCode: data.device_code,
				interval: data.interval || 5,
			});
		} catch (err) {
			setDeviceState({ status: 'error', error: 'Failed to connect to server' });
		}
	}, [invalidatePolling]);

	const startCountdown = useCallback((seconds?: number) => {
		clearCountdown();
		const interval = (seconds ?? deviceState.interval) || 5;
		setCountdown(interval);
		countdownRef.current = setInterval(() => {
			setCountdown(prev => {
				if (prev === null || prev <= 1) return 0;
				return prev - 1;
			});
		}, 1000);
	}, [clearCountdown, deviceState.interval]);

	const pollOnce = useCallback(async () => {
		if (!deviceState.deviceCode || authTypeRef.current !== 'device_login') return;

		clearCountdown();
		setIsChecking(true);
		const pollSession = pollSessionRef.current;

		try {
			const baseUrl = getApiBaseUrl();
			const resp = await fetch(`${baseUrl}/providers/copilot/device-login/poll`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ device_code: deviceState.deviceCode }),
			});
			if (pollSession !== pollSessionRef.current || authTypeRef.current !== 'device_login') {
				return;
			}
			if (!resp.ok) {
				setDeviceState(prev => ({ ...prev, status: 'error', error: 'Failed to check authorization status' }));
				return;
			}
			const data = await resp.json();
			if (pollSession !== pollSessionRef.current || authTypeRef.current !== 'device_login') {
				return;
			}

			if (data.status === 'complete' && data.access_token) {
				form.setValue('key.value', { value: data.access_token, env_var: '', from_env: false }, { shouldDirty: true, shouldValidate: true });
				setDeviceState(prev => ({ ...prev, status: 'complete' }));

				// Build the payload from current form values, stripping internal helpers.
				const buildPayload = () => {
					const keyValues: any = { ...form.getValues('key') };
					if (keyValues.azure_key_config) {
						const { _auth_type, ...rest } = keyValues.azure_key_config;
						keyValues.azure_key_config = rest;
					}
					if (keyValues.vertex_key_config) {
						const { _auth_type, ...rest } = keyValues.vertex_key_config;
						keyValues.vertex_key_config = rest;
					}
					if (keyValues.bedrock_key_config) {
						const { _auth_type, ...rest } = keyValues.bedrock_key_config;
						keyValues.bedrock_key_config = rest;
					}
					return keyValues;
				};

				if (keyId) {
					// Editing an existing key: persist the new token in place, then refresh
					// so the dropdown reflects what Copilot serves for this account.
					const valid = await form.trigger();
					if (!valid) {
						toast.info('Token obtained. Fix validation errors and click Save to refresh models.');
						return;
					}
					const keyValues = buildPayload();
					try {
						await updateProviderKey({ provider: providerName, keyId, key: keyValues }).unwrap();
						form.reset(form.getValues(), { keepValues: true });
						try {
							await refreshModels(providerName).unwrap();
							toast.success('Token saved. Models refreshed.');
						} catch {
							toast.success('Token saved.', { description: 'Model refresh failed; try the refresh icon.' });
						}
						onReauthComplete?.();
					} catch {
						toast.error('Token obtained but failed to save.', {
							description: 'Click Save to commit and refresh models.',
						});
					}
					return;
				}

				// Brand-new key: the model picker shows nothing until the backend has
				// discovered the catalog for this token, which only happens after the
				// key is saved. Auto-create the key here so the user can pick allowed
				// models within the same flow; the form transitions to 'edit' mode
				// via onAutoCreated, and the eventual Save click becomes an update.
				if (!createProviderKey) {
					toast.success('Token obtained.', { description: 'Click Save to commit and refresh models.' });
					return;
				}
				const keyValues = buildPayload();
				if (!keyValues.name || !String(keyValues.name).trim()) {
					keyValues.name = 'GitHub Copilot';
					form.setValue('key.name', keyValues.name, { shouldDirty: true });
				}
				const valid = await form.trigger();
				if (!valid) {
					toast.info('Token obtained. Fix validation errors and click Save to refresh models.');
					return;
				}
				try {
					const newKey = await createProviderKey({ provider: providerName, key: keyValues }).unwrap();
					onAutoCreated?.(newKey.id);
					// Mark the form clean so the Save button only re-enables on actual edits.
					form.reset(form.getValues(), { keepValues: true });
					try {
						await refreshModels(providerName).unwrap();
						toast.success('Key saved. Models refreshed.', {
							description: 'Pick allowed models or click Save to keep all.',
						});
					} catch {
						toast.success('Key saved.', { description: 'Model refresh failed; try the refresh icon.' });
					}
				} catch {
					toast.error('Token obtained but failed to save.', {
						description: 'Click Save to commit and refresh models.',
					});
				}
				return;
			}

			if (data.status === 'expired' || data.status === 'error') {
				setDeviceState(prev => ({ ...prev, status: 'error', error: data.error || 'Authorization failed' }));
				return;
			}

			// Still pending — restart countdown.
			// If GitHub sent "slow_down", increase the interval by 5s as per the device flow spec.
			let nextInterval = deviceState.interval || 5;
			if (data.status === 'slow_down') {
				nextInterval += 5;
				setDeviceState(prev => ({ ...prev, interval: nextInterval }));
			}
			startCountdown(nextInterval);
		} catch {
			if (pollSession === pollSessionRef.current && authTypeRef.current === 'device_login') {
				setDeviceState(prev => ({ ...prev, status: 'error', error: 'Failed to connect to server' }));
			}
		} finally {
			if (pollSession === pollSessionRef.current) {
				setIsChecking(false);
			}
		}
	}, [
		deviceState.deviceCode,
		deviceState.interval,
		form,
		clearCountdown,
		startCountdown,
		keyId,
		providerName,
		updateProviderKey,
		refreshModels,
		createProviderKey,
		onAutoCreated,
		onReauthComplete,
	]);

	// Trigger poll when countdown reaches 0 (only in device_login mode)
	useEffect(() => {
		if (countdown === 0 && !isChecking && copilotAuthType === 'device_login') {
			pollOnce();
		}
	}, [countdown, isChecking, pollOnce, copilotAuthType]);

	const copyCode = useCallback(() => {
		if (deviceState.userCode) {
			navigator.clipboard.writeText(deviceState.userCode);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [deviceState.userCode]);

	// Auto-start countdown when user code is obtained
	useEffect(() => {
		if (deviceState.status === 'awaiting_auth' && deviceState.userCode) {
			startCountdown();
		}
	}, [deviceState.status, deviceState.userCode, startCountdown]);

	const resetFlow = useCallback(() => {
		invalidatePolling();
		clearCountdown();
		setIsChecking(false);
		setDeviceState({ status: 'idle' });
	}, [clearCountdown, invalidatePolling]);

	return (
		<div className="space-y-4">
			<Separator className="my-6" />
			<div className="space-y-2">
				<FormLabel>Authentication Method</FormLabel>
				<Tabs value={copilotAuthType} onValueChange={(v) => {
					setCopilotAuthType(v as 'device_login' | 'manual_token' | 'github_app');
					if (v === 'device_login') {
						resetFlow();
					} else {
						// Switching away from device login — stop any active polling
						invalidatePolling();
						clearCountdown();
						setIsChecking(false);
					}
				}}>
					<TabsList className="grid w-full grid-cols-3">
						<TabsTrigger data-testid="apikey-copilot-device-login-tab" value="device_login">GitHub Device Login</TabsTrigger>
						<TabsTrigger data-testid="apikey-copilot-manual-token-tab" value="manual_token">Manual Token</TabsTrigger>
						<TabsTrigger data-testid="apikey-copilot-github-app-tab" value="github_app">GitHub App</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>

			{copilotAuthType === 'device_login' && (
				<div className="space-y-4">
					{deviceState.status === 'idle' && (
						<>
							<Alert variant="default">
								<Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
								<AlertTitle>GitHub Copilot Authentication</AlertTitle>
								<AlertDescription>
									Copilot requires a GitHub OAuth token obtained through the device login flow.
									Your GitHub account must have an active Copilot subscription.
								</AlertDescription>
							</Alert>
							<Button
								type="button"
								data-testid="copilot-device-login-button"
								onClick={initiateLogin}
								className="w-full"
							>
								Login with GitHub
							</Button>
						</>
					)}

					{deviceState.status === 'awaiting_auth' && deviceState.userCode && (
						<div className="space-y-4">
							<Alert variant="default">
								<Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
								<AlertTitle>Enter this code on GitHub</AlertTitle>
								<AlertDescription className="space-y-3">
									<div className="flex items-center gap-3 pt-2">
										<code className="bg-muted rounded-md px-4 py-2 text-2xl font-bold tracking-widest">
											{deviceState.userCode}
										</code>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={copyCode}
											data-testid="copilot-copy-code-button"
										>
											{copied ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
										</Button>
									</div>
									<p className="text-sm">
										Visit{" "}
										{deviceState.verificationUri &&
										 /^https:\/\/([a-z0-9-]+\.)*github\.com(\/|$)/i.test(deviceState.verificationUri) ? (
											<a
												href={deviceState.verificationUri}
												target="_blank"
												rel="noopener noreferrer"
												data-testid="copilot-verification-link"
												className="text-blue-600 underline hover:text-blue-800 inline-flex items-center gap-1"
											>
												{deviceState.verificationUri}
												<ExternalLink className="h-3 w-3" />
											</a>
										) : (
											<code data-testid="copilot-verification-link" className="bg-muted rounded px-1 py-0.5 text-sm">
												{deviceState.verificationUri}
											</code>
										)}
										{" "}and enter the code above to authorize Bifrost.
									</p>
								</AlertDescription>
							</Alert>

							<Button
								type="button"
								data-testid="copilot-confirm-auth-button"
								onClick={pollOnce}
								disabled={isChecking}
								className="w-full"
							>
								{isChecking ? (
									<><Loader2 className="h-4 w-4 animate-spin" /> Checking authorization...</>
								) : countdown !== null && countdown > 0 ? (
									<>Check authorization ({countdown}s)</>
								) : (
									<>Check authorization</>
								)}
							</Button>

							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={resetFlow}
								className="w-full"
								data-testid="copilot-cancel-login-button"
							>
								Cancel and start over
							</Button>
						</div>
					)}

					{deviceState.status === 'complete' && (
						<Alert variant="default">
							<CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
							<AlertTitle>Authentication successful</AlertTitle>
							<AlertDescription>
								GitHub OAuth token has been set. You can now save the provider configuration.
							</AlertDescription>
						</Alert>
					)}

					{deviceState.status === 'error' && (
						<div className="space-y-3">
							<Alert variant="destructive">
								<AlertTitle>Authentication failed</AlertTitle>
								<AlertDescription>
									{deviceState.error || 'An unknown error occurred'}
								</AlertDescription>
							</Alert>
							<Button
								type="button"
								variant="outline"
								onClick={initiateLogin}
								className="w-full"
								data-testid="copilot-retry-login-button"
							>
								Try again
							</Button>
						</div>
					)}
				</div>
			)}

			{copilotAuthType === 'manual_token' && (
				<div className="space-y-2">
					<Alert variant="default">
						<Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
						<AlertTitle>Manual Token Entry</AlertTitle>
						<AlertDescription>
							Enter an OAuth access token obtained from the GitHub device code flow.
							Standard GitHub PATs will not work — you must use the device login flow token.
						</AlertDescription>
					</Alert>
					<FormField
						control={control}
						name={`key.value`}
						render={({ field }) => {
							// Auto-detect indicator: classify the pasted token by prefix (mirrors Go's
							// detectCredentialKind exactly, WBS 2.2) so the operator sees which mode was
							// recognized instead of guessing blind. A github_pat_ token still exchanges
							// through this same device-flow endpoint, so it's flagged "fine-grained PAT"
							// rather than treated as an error — only a fully unrecognized prefix is.
							const rawToken = (field.value?.value ?? "") as string;
							const kind = rawToken.trim() ? detectCredentialKind(rawToken) : "unknown";
							const showBadge = rawToken.trim() !== "" && !isRedacted(rawToken);
							const kindLabel: Record<typeof kind, string> = {
								oauth_user_token: "Detected: GitHub OAuth token (gho_)",
								github_app_user_token: "Detected: GitHub App user token (ghu_)",
								fine_grained_pat: "Detected: fine-grained PAT (github_pat_)",
								unknown: "No recognized GitHub token prefix",
							};
							return (
								<FormItem>
									<FormLabel>OAuth Access Token</FormLabel>
									<FormControl>
										<SecretVarInput placeholder="ghu_xxxxxxxxxxxx or env.GITHUB_COPILOT_TOKEN" type="text" {...field} />
									</FormControl>
									{showBadge && (
										<div
											data-testid="copilot-token-detect-badge"
											className={cn(
												"flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs",
												isOAuthExchangeCredential(kind)
													? "border-green-200 bg-green-50 text-green-800"
													: "border-amber-200 bg-amber-50 text-amber-800",
											)}
										>
											{isOAuthExchangeCredential(kind) ? (
												<CheckCircle2 className="size-3.5 shrink-0" />
											) : (
												<Info className="size-3.5 shrink-0" />
											)}
											<span>{kindLabel[kind]}</span>
										</div>
									)}
									<FormMessage />
								</FormItem>
							);
						}}
					/>
				</div>
			)}
			{copilotAuthType === 'github_app' && (
				<div className="space-y-4">
					<Alert variant="default">
						<Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
						<AlertTitle>GitHub App (Server-to-Server)</AlertTitle>
						<AlertDescription>
							Usage bills to the organization that owns the installation, and no individual Copilot seat is used — the right choice for a
							shared gateway. The App needs the Copilot Requests permission at Read &amp; write, installed on the organization with All
							repositories access, and that organization must allow Copilot requests from GitHub App installations.{" "}
							<a
								href="https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens"
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:underline"
								data-testid="copilot-docs-link-server-to-server"
							>
								Set up a GitHub App for Copilot
							</a>
						</AlertDescription>
					</Alert>
					<GithubAppKeyConfigFields control={control} copilotAppSuffix="(Required)" />
				</div>
			)}
		</div>
	);
}
