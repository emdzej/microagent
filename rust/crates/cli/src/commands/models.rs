//! `models` subcommand, porting `packages/cli/src/bin.ts`.

use anyhow::{Result, bail};
use microagent_core::list_models_for_provider;

use crate::cli::ProviderOpts;
use crate::config::load_config;

pub async fn run(opts: &ProviderOpts) -> Result<()> {
    let loaded = load_config(opts)?;
    let providers = loaded.config.resolve_providers();

    if providers.is_empty() {
        bail!("No providers configured.");
    }

    let mut total = 0usize;
    for pc in &providers {
        let label = pc.label();
        println!("\n{label}:");

        match list_models_for_provider(&pc.kind, pc.base_url.as_deref(), pc.api_key.as_deref())
            .await
        {
            Ok(models) if models.is_empty() => println!("  (no models found)"),
            Ok(models) => {
                for m in &models {
                    println!("  {label}/{}", m.id);
                }
                total += models.len();
            }
            // One unreachable provider must not hide the others.
            Err(err) => eprintln!("  Error: {err}"),
        }
    }

    println!("\n{total} model(s) across {} provider(s).", providers.len());
    Ok(())
}
