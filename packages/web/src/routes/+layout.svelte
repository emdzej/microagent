<script>
  import "../app.css";
  let { children } = $props();
</script>

<div class="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
  {@render children()}
</div>
