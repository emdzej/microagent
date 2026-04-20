<script lang="ts">
  import { streamChat, fetchStats, fetchTools, fetchHealth } from "$lib/api";
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
  let chatEl: HTMLElement | undefined = $state();
  let nextId = 0;

  // Load initial data
  $effect(() => {
    fetchHealth().then((h) => (providerName = h.provider));
    fetchTools().then((t) => (tools = t));
    fetchStats().then((s) => (stats = s));
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

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    input = "";
    addMessage("user", text);
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
    });
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
  <header class="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
    <div class="flex items-center gap-3">
      <h1 class="text-lg font-bold text-zinc-100">microagent</h1>
      <span class="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{providerName}</span>
    </div>
    <div class="flex items-center gap-3">
      <button
        class="text-xs px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
        onclick={() => (showTools = !showTools)}
      >
        tools ({tools.length})
      </button>
    </div>
  </header>

  <!-- Tools panel -->
  {#if showTools}
    <div class="border-b border-zinc-800 bg-zinc-900 px-4 py-3 max-h-48 overflow-y-auto">
      <p class="text-xs text-zinc-500 mb-2">Registered tools:</p>
      {#each tools as tool}
        <div class="flex gap-2 text-xs py-1">
          <span class="text-emerald-400 shrink-0">{tool.name}</span>
          <span class="text-zinc-500 truncate">{tool.description}</span>
        </div>
      {:else}
        <p class="text-xs text-zinc-600">No tools registered</p>
      {/each}
    </div>
  {/if}

  <!-- Chat messages -->
  <div class="flex-1 overflow-y-auto px-4 py-4 space-y-3" bind:this={chatEl}>
    {#if messages.length === 0}
      <div class="flex items-center justify-center h-full">
        <p class="text-zinc-600 text-sm">Send a message to start chatting</p>
      </div>
    {/if}

    {#each messages as msg (msg.id)}
      <div
        class="flex gap-3 {msg.role === 'user' ? 'justify-end' : ''}"
      >
        <div
          class="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap
            {msg.role === 'user'
              ? 'bg-blue-600/20 text-blue-100 border border-blue-500/20'
              : msg.role === 'assistant'
                ? 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                : msg.role === 'tool'
                  ? 'bg-yellow-500/10 text-yellow-200/80 border border-yellow-500/10 text-xs font-mono'
                  : 'bg-red-500/10 text-red-300 border border-red-500/20 text-xs'}"
        >
          {msg.content}
        </div>
      </div>
    {/each}

    <!-- Streaming indicator -->
    {#if streaming}
      <div class="flex gap-3">
        <div class="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-zinc-800 text-zinc-200 border border-zinc-700 whitespace-pre-wrap">
          {streaming}<span class="animate-pulse">▊</span>
        </div>
      </div>
    {/if}

    {#if busy && !streaming}
      <div class="flex gap-3">
        <div class="rounded-lg px-3 py-2 text-sm bg-zinc-800 text-zinc-500 border border-zinc-700">
          <span class="animate-pulse">thinking...</span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Input -->
  <div class="border-t border-zinc-800 px-4 py-3">
    <div class="flex gap-2">
      <textarea
        class="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm
               text-zinc-100 placeholder-zinc-600 resize-none
               focus:outline-none focus:border-zinc-500 transition-colors"
        rows="1"
        placeholder={busy ? "Waiting for response..." : "Type a message... (Enter to send)"}
        disabled={busy}
        bind:value={input}
        onkeydown={handleKey}
      ></textarea>
      <button
        class="px-4 py-2 rounded-lg text-sm font-medium transition-colors
               {busy
                 ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                 : 'bg-blue-600 hover:bg-blue-500 text-white'}"
        disabled={busy}
        onclick={send}
      >
        Send
      </button>
    </div>
  </div>

  <!-- Stats bar -->
  <footer class="px-4 py-2 border-t border-zinc-800 bg-zinc-900/50">
    <p class="text-xs text-zinc-600 text-center">{tokenDisplay}</p>
  </footer>
</div>
