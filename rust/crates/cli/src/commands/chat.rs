//! Interactive chat, porting `startChat` in `packages/cli/src/app.ts`.

use anyhow::Result;

use crate::cli::ProviderOpts;
use crate::config::load_config;

pub async fn run(opts: &ProviderOpts) -> Result<()> {
    let loaded = load_config(opts)?;
    let agent = crate::commands::build_agent(loaded.config).await?;

    let result = crate::tui::run(agent.clone(), loaded.path).await;
    agent.shutdown().await;
    result
}
