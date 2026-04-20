<script lang="ts">
  import { streamChat, fetchStats, fetchTools, fetchHealth, fetchModels, fetchCurrentModel, setModel } from "$lib/api";
  import type { Stats } from "$lib/api";
  import { tick } from "svelte";

  interface Message {
    id: number;
    role: "user" | "assistant" | "tool" | "error";
    content: string;
  }

  let messages: Message[] = $state([]);
  let input = $state("");
  let streaming = $state("");
  let busy = $state(false);
  let stats: Stats | null = $state(null);
  let tools: Array<{ name: string; description: string }> = $state([]);
  let showTools = $state(false);
  let providerName = $state("...");
  let currentModel = $state("...");
  let availableModels: Array<{ id: string }> = $state([]);
  let showModelPicker = $state(false);
  let chatEl: HTMLElement | undefined = $state();
  let pendingImages: string[] = $state([]);
  let fileInput: HTMLInputElement | undefined = $state();
  let nextId = 0;

  // Load initial data
  $effect(() => {
    fetchHealth().then((h) => (providerName = h.provider));
    fetchTools().then((t) => (tools = t));
    fetchStats().then((s) => (stats = s));
    fetchCurrentModel().then((m) => (currentModel = m.model));
  });

  function scrollBottom() {
    tick().then(() => {
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    });
  }

  function addMessage(role: Message["role"], content: string) {
    messages.push({ id: nextId++, role, content });
    scrollBottom();
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(files: FileList | File[]) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await readFileAsDataUrl(file);
      pendingImages.push(dataUrl);
    }
  }

  function removeImage(index: number) {
    pendingImages.splice(index, 1);
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      addImageFiles(imageFiles);
    }
  }

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    input = "";

    // ── Slash commands ──────────────────────────────────────────
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ");

      switch (cmd) {
        case "/help":
          addMessage("assistant",
            "Available commands:\n" +
            "  /help         — show this message\n" +
            "  /stats        — show token usage stats\n" +
            "  /tools        — list registered tools\n" +
            "  /models       — list available models\n" +
            "  /model <name> — switch active model\n" +
            "  /clear        — clear chat history"
          );
          return;

        case "/stats":
          fetchStats().then((s) => {
            stats = s;
            addMessage("assistant",
              `Tokens: ${s.totalTokens} (${s.promptTokens} prompt + ${s.completionTokens} completion)\n` +
              `Requests: ${s.requests} | Tool calls: ${s.toolCalls}`
            );
          });
          return;

        case "/tools":
          addMessage("assistant",
            tools.length
              ? `Registered tools (${tools.length}):\n` + tools.map((t) => `  ${t.name} — ${t.description}`).join("\n")
              : "No tools registered."
          );
          return;

        case "/models":
          addMessage("assistant", "Fetching models...");
          fetchModels().then((m) => {
            availableModels = m;
            addMessage("assistant",
              m.length
                ? `Available models (${m.length}):\n` + m.map((x) => `  ${x.id}`).join("\n")
                : "No models found."
            );
          }).catch((e) => addMessage("error", `Failed to fetch models: ${e}`));
          return;

        case "/model":
          if (!arg) {
            addMessage("assistant", `Current model: ${currentModel}`);
            return;
          }
          setModel(arg).then((res) => {
            currentModel = res.model;
            addMessage("assistant", `Switched to model: ${res.model}${res.persisted ? " (saved to config)" : ""}`);
          }).catch((e) => addMessage("error", `Failed to switch model: ${e}`));
          return;

        case "/clear":
          messages = [];
          return;

        default:
          addMessage("error", `Unknown command: ${cmd}. Type /help for available commands.`);
          return;
      }
    }

    // ── Regular message ─────────────────────────────────────────
    const images = pendingImages.length ? [...pendingImages] : undefined;
    pendingImages = [];
    addMessage("user", images ? `${text} [+${images.length} image(s)]` : text);
    busy = true;
    streaming = "";

    streamChat(text, {
      onText(t) {
        streaming += t;
        scrollBottom();
      },
      onToolCall(name) {
        addMessage("tool", `→ ${name}`);
      },
      onToolResult(name, content, isError) {
        const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
        addMessage(isError ? "error" : "tool", `← ${name}: ${preview}`);
      },
      onComplete(response, newStats) {
        streaming = "";
        addMessage("assistant", response);
        stats = newStats;
        busy = false;
      },
      onError(err) {
        streaming = "";
        addMessage("error", err);
        busy = false;
      },
    }, images);
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  let tokenDisplay = $derived(
    stats
      ? `${stats.totalTokens} tokens | ${stats.promptTokens}↑ ${stats.completionTokens}↓ | ${stats.requests} reqs | ${stats.toolCalls} calls`
      : "..."
  );
</script>

<div class="flex flex-col h-screen max-w-4xl mx-auto">
  <!-- Header -->
  <header class="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
    <div class="flex items-center gap-3">
      <h1 class="text-lg font-bold text-zinc-900">microagent</h1>
      <span class="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-500">{providerName}</span>
      <button
        class="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-500 hover:bg-zinc-200 transition-colors cursor-pointer"
        onclick={() => {
          showModelPicker = !showModelPicker;
          if (showModelPicker && !availableModels.length) {
            fetchModels().then((m) => (availableModels = m));
          }
        }}
      >
        {currentModel}
      </button>
    </div>
    <div class="flex items-center gap-3">
      <button
        class="text-xs px-2 py-1 rounded hover:bg-zinc-100 text-zinc-500 transition-colors"
        onclick={() => (showTools = !showTools)}
      >
        tools ({tools.length})
      </button>
    </div>
  </header>

  <!-- Tools panel -->
  {#if showTools}
    <div class="border-b border-zinc-200 bg-zinc-50 px-4 py-3 max-h-48 overflow-y-auto">
      <p class="text-xs text-zinc-400 mb-2">Registered tools:</p>
      {#each tools as tool}
        <div class="flex gap-2 text-xs py-1">
          <span class="text-emerald-600 shrink-0">{tool.name}</span>
          <span class="text-zinc-500 truncate">{tool.description}</span>
        </div>
      {:else}
        <p class="text-xs text-zinc-400">No tools registered</p>
      {/each}
    </div>
  {/if}

  <!-- Model picker -->
  {#if showModelPicker}
    <div class="border-b border-zinc-200 bg-zinc-50 px-4 py-3 max-h-48 overflow-y-auto">
      <p class="text-xs text-zinc-400 mb-2">Select model:</p>
      {#each availableModels as m}
        <button
          class="block w-full text-left text-xs py-1 px-2 rounded hover:bg-zinc-200 transition-colors
                 {m.id === currentModel ? 'text-blue-600 font-medium' : 'text-zinc-700'}"
          onclick={async () => {
            await setModel(m.id);
            currentModel = m.id;
            showModelPicker = false;
          }}
        >
          {m.id} {m.id === currentModel ? '(active)' : ''}
        </button>
      {:else}
        <p class="text-xs text-zinc-400">Loading models...</p>
      {/each}
    </div>
  {/if}

  <!-- Chat messages -->
  <div class="flex-1 overflow-y-auto px-4 py-4 space-y-3" bind:this={chatEl}>
    {#if messages.length === 0}
      <div class="flex items-center justify-center h-full">
        <p class="text-zinc-400 text-sm">Send a message to start chatting</p>
      </div>
    {/if}

    {#each messages as msg (msg.id)}
      <div
        class="flex gap-3 {msg.role === 'user' ? 'justify-end' : ''}"
      >
        <div
          class="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap
            {msg.role === 'user'
              ? 'bg-blue-50 text-blue-900 border border-blue-200'
              : msg.role === 'assistant'
                ? 'bg-zinc-50 text-zinc-800 border border-zinc-200'
                : msg.role === 'tool'
                  ? 'bg-amber-50 text-amber-800 border border-amber-200 text-xs font-mono'
                  : 'bg-red-50 text-red-700 border border-red-200 text-xs'}"
        >
          {msg.content}
        </div>
      </div>
    {/each}

    <!-- Streaming indicator -->
    {#if streaming}
      <div class="flex gap-3">
        <div class="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-zinc-50 text-zinc-800 border border-zinc-200 whitespace-pre-wrap">
          {streaming}<span class="animate-pulse">▊</span>
        </div>
      </div>
    {/if}

    {#if busy && !streaming}
      <div class="flex gap-3">
        <div class="rounded-lg px-3 py-2 text-sm bg-zinc-50 text-zinc-400 border border-zinc-200">
          <span class="animate-pulse">thinking...</span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Input -->
  <div class="border-t border-zinc-200 px-4 py-3">
    <!-- Pending images preview -->
    {#if pendingImages.length}
      <div class="flex gap-2 mb-2 flex-wrap">
        {#each pendingImages as img, i}
          <div class="relative group">
            <img src={img} alt="pending" class="w-16 h-16 object-cover rounded border border-zinc-200" />
            <button
              class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-xs
                     flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              onclick={() => removeImage(i)}
            >&times;</button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="flex gap-2">
      <input
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        bind:this={fileInput}
        onchange={(e) => { const t = e.target as HTMLInputElement; if (t.files) addImageFiles(t.files); t.value = ""; }}
      />
      <button
        class="px-2 py-2 rounded-lg text-sm border border-zinc-300 hover:bg-zinc-100 text-zinc-500 transition-colors shrink-0"
        title="Attach image"
        disabled={busy}
        onclick={() => fileInput?.click()}
      >
        +img
      </button>
      <textarea
        class="flex-1 bg-white border border-zinc-300 rounded-lg px-3 py-2 text-sm
               text-zinc-900 placeholder-zinc-400 resize-none
               focus:outline-none focus:border-zinc-400 transition-colors"
        rows="1"
        placeholder={busy ? "Waiting for response..." : pendingImages.length ? "Describe the image(s)... (Enter to send)" : "Type a message... (Enter to send, paste images)"}
        disabled={busy}
        bind:value={input}
        onkeydown={handleKey}
        onpaste={handlePaste}
      ></textarea>
      <button
        class="px-4 py-2 rounded-lg text-sm font-medium transition-colors
               {busy
                 ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
                 : 'bg-blue-600 hover:bg-blue-500 text-white'}"
        disabled={busy}
        onclick={send}
      >
        Send
      </button>
    </div>
  </div>

  <!-- Stats bar -->
  <footer class="px-4 py-2 border-t border-zinc-200 bg-zinc-50">
    <p class="text-xs text-zinc-400 text-center">{tokenDisplay}</p>
  </footer>
</div>
