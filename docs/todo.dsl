#!dsl/v1
@project:stealth-browser-mcp (forked)
@purpose:Playwright stealth MCP for financial account scraping
@origin:JamesChampion/stealth-browser-mcp
@upstream:brian-ln/stealth-browser-mcp

---

@todo:{
  @setup:{
    [x]=>fork repo to JamesChampion
    [x]=>clone locally
    [x]=>configure remotes (origin=us, upstream=original)
    [x]=>install dependencies (bun install)
    [x]=>test basic functionality
  }

  @integration:{
    [x]=>add to Claude Code MCP config
    [x]=>test stealth login on simple site
    [x]=>add Doppler integration for credentials
    [x]=>add TOTP support for MFA
  }

  @financial_scripts:{
    [x]=>Directions CU login script
    [ ]=>Citi login script
    [ ]=>BoFA login script
    [ ]=>Discover login script
    [ ]=>Chase login script
    [ ]=>Synchrony login script
    [ ]=>Fidelity login script
    [ ]=>Toledo Edison login script
    [ ]=>Columbia Gas login script
    [ ]=>Buckeye Cable login script
    [ ]=>Venmo CSV export script
    [ ]=>Cash App login script
  }

  @enhancements:{
    [x]=>session persistence (cookie storage)
    [x]=>retry logic with exponential backoff
    [x]=>screenshot on failure for debugging
    [x]=>structured data extraction helpers
  }
}

@notes:{
  ~all pushes go to JamesChampion fork
  ~pull from upstream for updates: git fetch upstream && git merge upstream/main
  ~cost: $0 (vs $7.20/year for Plaid)
}
