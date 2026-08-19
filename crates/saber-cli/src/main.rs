//! The `saber` binary. M0 skeleton: subcommand dispatch is a placeholder;
//! `saber exec -p` headless mode lands with T6.

fn main() -> anyhow::Result<()> {
    let subcommand = std::env::args().nth(1).unwrap_or_else(|| "tui".to_string());
    println!(
        "saber {} (engine {}, protocol {}) — subcommand `{}` not yet forged (M0 skeleton)",
        env!("CARGO_PKG_VERSION"),
        saber_core::ENGINE_VERSION,
        saber_protocol::PROTOCOL_VERSION,
        subcommand
    );
    Ok(())
}
