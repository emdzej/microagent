<script>
  import "../app.css";
  let { children } = $props();
</script>

<div class="min-h-screen bg-white text-zinc-900 font-mono">
  {@render children()}
</div>
