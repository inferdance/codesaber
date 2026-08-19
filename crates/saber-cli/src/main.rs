//! The `saber` binary. M0 skeleton: subcommand dispatch is a placeholder;
//! `saber exec -p` headless mode lands with T6.

fn main() -> anyhow::Result<()> {
    // args_os: never panics on non-UTF-8 argv (a legal Unix condition);
    // we only echo the subcommand here, so lossy display is fine.
    let subcommand = std::env::args_os()
        .nth(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tui".to_string());
    println!(
        "saber {} (engine {}, protocol {}) — subcommand `{}` not yet forged (M0 skeleton)",
        env!("CARGO_PKG_VERSION"),
        saber_core::ENGINE_VERSION,
        saber_protocol::PROTOCOL_VERSION,
        subcommand
    );
    Ok(())
}
