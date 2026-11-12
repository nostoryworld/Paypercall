// PayPerCall v2 frontend — served by the worker at GET /.
// Listings come from the on-chain registry (GET /api/listings).
// NOTE: this file is a JS template literal. The HTML/JS below must not
// contain backticks or "${" sequences.
export const FRONTEND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PayPerCall — paid API marketplace for AI agents</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #111; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 1rem; margin: 1rem 0; }
  .muted { color: #666; font-size: 0.9rem; }
  .banner { background: #fff7e0; border: 1px solid #e6cf7a; border-radius: 8px; padding: 0.6rem 0.9rem; font-size: 0.9rem; }
  code, pre { background: #f5f5f5; padding: 2px 6px; border-radius: 6px; }
  pre { padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
  button { padding: 0.6rem 1.2rem; border: none; border-radius: 8px; background: #0a58ca; color: #fff; cursor: pointer; font-size: 1rem; }
  button.demo { background: #7c3aed; }
  button:disabled { background: #999; }
  input { width: 100%; padding: 0.6rem; margin: 0.4rem 0; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; }
  ol.instructions li { margin: 0.4rem 0; }
  .badge { display: inline-block; padding: 0.25rem 0.8rem; border-radius: 999px; font-weight: 700; color: #fff; }
  .badge.low { background: #1a9e4b; }
  .badge.caution { background: #e8930c; }
  .badge.high { background: #d92b2b; }
  table.report { border-collapse: collapse; width: 100%; margin: 0.6rem 0; }
  table.report td { border-bottom: 1px solid #eee; padding: 0.35rem 0.4rem; vertical-align: top; }
  table.report td.k { color: #555; width: 42%; }
  .score { font-size: 1.6rem; font-weight: 800; }
  .summary { font-size: 1.05rem; background: #f2f7ff; border: 1px solid #cfe2ff; border-radius: 8px; padding: 0.7rem 0.9rem; }
  .flags { color: #a33; }
  .ok { color: #1a9e4b; }
  a.txlink { word-break: break-all; }
</style>
</head>
<body>
<h1>PayPerCall</h1>
<p class="muted">Paid API marketplace for AI agents. Sellers register paid endpoints in an on-chain registry contract; buyers pay per call in NEAR, the platform verifies the payment on-chain and serves exactly one call.</p>
<p class="banner">Listings below are read <b>live from the on-chain registry</b> — PayPerCallRegistry at <code>paypercall-dev-t34qd7c9.testnet</code>. Payments are NEAR <b>testnet</b> (testNEAR, no real value); services read live NEAR mainnet/testnet data.</p>

<h2>Marketplace</h2>
<div id="listings"><p class="muted">Loading listings from chain...</p></div>

<h2>Sell an endpoint</h2>
<div class="card">
  <p>Listings are not created here — they live on-chain. Register yours by calling
  <code>register_listing</code> on the registry contract from your seller account:</p>
  <pre>near contract call-function as-transaction \\
  paypercall-dev-t34qd7c9.testnet register_listing json-args \\
  '{"name":"My API","description":"What it does","endpoint_url":"https://example.com/api","price_yocto":"1000000000000000000000"}' \\
  prepaid-gas '30 TeraGas' attached-deposit '0 NEAR' \\
  sign-as YOUR-ACCOUNT.testnet sign-with-keypair</pre>
  <p class="muted">price_yocto is the per-call price in yoctoNEAR (1000000000000000000000 = 0.001 NEAR).</p>
</div>

<script>
var SAMPLE_TOKEN = "usdt.tether-token.near";
var SAMPLE_ACCOUNT = "wrap.near";
var SAMPLE_NAME = "satoshi.near";

var api = function (p, opts) {
  return fetch(p, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.detail || data.error || ("HTTP " + r.status));
      return data;
    });
  });
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function listingType(l) {
  var u = l.endpoint_url || "";
  if (u.indexOf("/paid/token-scan") !== -1) return "scan";
  if (u.indexOf("/paid/wallet-xray") !== -1) return "xray";
  if (u.indexOf("/paid/name-check") !== -1) return "namecheck";
  return "generic";
}

function verdictClass(v) {
  if (!v) return "high";
  if (v.indexOf("LOW") === 0) return "low";
  if (v.indexOf("CAUTION") === 0) return "caution";
  return "high";
}

function row(k, v) {
  return "<tr><td class='k'>" + escapeHtml(k) + "</td><td>" + v + "</td></tr>";
}

function na(v) { return v == null ? "<span class='muted'>n/a</span>" : escapeHtml(v); }

function renderScanReport(body) {
  var name = body.token_name || "Unknown token";
  var sym = body.token_symbol ? " (" + body.token_symbol + ")" : "";
  var supply = body.total_supply == null
    ? "<span class='muted'>n/a</span>"
    : escapeHtml(body.total_supply) + (body.token_symbol ? " " + escapeHtml(body.token_symbol) : "");
  var known = body.known_token
    ? "<span class='ok'>Yes — " + escapeHtml(body.registry_match || "canonical contract") + "</span>"
    : "Not in the known-token registry";
  var codeHash = body.code_hash ? String(body.code_hash).slice(0, 12) + "..." : "n/a";
  var html = "<h4>NEAR Token Safety Report</h4>" +
    "<p><span class='badge " + verdictClass(body.verdict) + "'>" + escapeHtml(body.verdict || "") + "</span>" +
    " &nbsp;<span class='score'>" + escapeHtml(body.risk_score) + "</span><span class='muted'> / 100 risk score</span></p>" +
    "<table class='report'>" +
    row("Token", escapeHtml(name + sym)) +
    row("Contract", "<code>" + escapeHtml(body.contract || "") + "</code>") +
    row("Network", "NEAR mainnet") +
    row("Known token", known) +
    row("Impersonation suspect", body.impersonation_suspect ? "<b style='color:#d92b2b'>YES — imitates " + escapeHtml(body.impersonates || "a known token") + "</b>" : "No") +
    row("Total supply", supply) +
    row("Holders", escapeHtml(body.holder_count == null ? "n/a" : Number(body.holder_count).toLocaleString("en-US"))) +
    row("Decimals", escapeHtml(body.token_decimals == null ? "n/a" : body.token_decimals)) +
    row("Contract code", body.has_contract_code ? "Deployed (hash " + escapeHtml(codeHash) + ")" : "None") +
    "</table>";
  if (body.flags && body.flags.length) {
    html += "<p class='flags'><b>Flags:</b></p><ul>" +
      body.flags.map(function (f) { return "<li>" + escapeHtml(f) + "</li>"; }).join("") + "</ul>";
  } else {
    html += "<p class='ok'>No risk flags raised.</p>";
  }
  html += "<p class='muted'>Source: " + escapeHtml(body.source || "NEAR mainnet RPC") + "</p>";
  return html;
}

function renderXrayReport(body) {
  var codeHash = body.code_hash ? String(body.code_hash).slice(0, 12) + "..." : "n/a";
  var storage = body.storage_used_bytes == null
    ? "n/a"
    : Number(body.storage_used_bytes).toLocaleString("en-US") + " bytes" +
      (body.storage_cost_near != null ? " (~" + body.storage_cost_near + " NEAR)" : "");
  var html = "<h4>NEAR Wallet X-Ray</h4>";
  if (body.summary) html += "<p class='summary'>" + escapeHtml(body.summary) + "</p>";
  html += "<table class='report'>" +
    row("Account", "<code>" + escapeHtml(body.account || "") + "</code>") +
    row("Network", "NEAR " + escapeHtml(body.network || "")) +
    row("Balance", escapeHtml(body.balance_near == null ? "n/a" : body.balance_near + " NEAR")) +
    row("Locked / staked", escapeHtml(body.locked_near == null ? "n/a" : body.locked_near + " NEAR")) +
    row("Storage used", storage) +
    row("Contract code", body.has_contract_code ? "Deployed (hash " + escapeHtml(codeHash) + ")" : "None") +
    row("Created", na(body.created_at ? String(body.created_at).slice(0, 10) : null)) +
    row("Transactions", body.tx_count == null ? "<span class='muted'>n/a</span>" : escapeHtml(Number(body.tx_count).toLocaleString("en-US"))) +
    "</table>";
  if (body.flags && body.flags.length) {
    html += "<p class='muted'><b>Notes:</b></p><ul>" +
      body.flags.map(function (f) { return "<li>" + escapeHtml(f) + "</li>"; }).join("") + "</ul>";
  }
  html += "<p class='muted'>Source: " + escapeHtml(body.source || "NEAR RPC") + "</p>";
  return html;
}

function renderNameCheckReport(body) {
  var taken = body.exists === true;
  var html = "<h4>NEAR Name Checker</h4>" +
    "<p><span class='badge " + (taken ? "high" : "low") + "'>" + (taken ? "TAKEN" : "AVAILABLE") + "</span>" +
    " &nbsp;<code>" + escapeHtml(body.account || "") + "</code></p>" +
    "<table class='report'>" +
    row("Account", "<code>" + escapeHtml(body.account || "") + "</code>") +
    row("Network", "NEAR " + escapeHtml(body.network || "")) +
    row("Exists", taken ? "Yes — this name is taken" : "No — this name is free") +
    row("Checked at", na(body.checked_at ? String(body.checked_at).slice(0, 19).replace("T", " ") + " UTC" : null)) +
    "</table>" +
    "<p class='muted'>Source: " + escapeHtml(body.source || "NEAR RPC") + "</p>";
  return html;
}

function renderResult(r) {
  var body = r && r.result ? r.result.body : null;
  var head = "";
  if (r && r.tx_hash) {
    head = "<p>Payment: <a class='txlink' target='_blank' rel='noopener' href='https://testnet.nearblocks.io/txns/" +
      escapeHtml(r.tx_hash) + "'>" + escapeHtml(r.tx_hash) + "</a></p>";
  }
  if (body && typeof body.risk_score === "number") {
    return head + renderScanReport(body) +
      "<details><summary class='muted'>Raw JSON</summary><pre>" + escapeHtml(JSON.stringify(body, null, 2)) + "</pre></details>";
  }
  if (body && typeof body.summary === "string" && body.account) {
    return head + renderXrayReport(body) +
      "<details><summary class='muted'>Raw JSON</summary><pre>" + escapeHtml(JSON.stringify(body, null, 2)) + "</pre></details>";
  }
  if (body && typeof body.available === "boolean" && typeof body.exists === "boolean") {
    return head + renderNameCheckReport(body) +
      "<details><summary class='muted'>Raw JSON</summary><pre>" + escapeHtml(JSON.stringify(body, null, 2)) + "</pre></details>";
  }
  var status = r && r.result ? r.result.status : "?";
  return head + "<h4>Result (upstream status " + escapeHtml(status) + ")</h4><pre>" +
    escapeHtml(JSON.stringify(body, null, 2)) + "</pre>";
}

function refresh() {
  var box = document.getElementById("listings");
  api("/api/listings").then(function (listings) {
    if (!listings.length) {
      box.innerHTML = "<p class='muted'>No active endpoints in the on-chain registry right now.</p>";
      return;
    }
    box.innerHTML = "";
    listings.forEach(function (l) { box.appendChild(buildCard(l)); });
  }).catch(function (e) {
    box.innerHTML = "<p>Failed to load listings from chain: " + escapeHtml(e.message) + "</p>";
  });
}

function buildCard(l) {
  var type = listingType(l);
  var div = document.createElement("div");
  div.className = "card";
  var html = "<h3>" + escapeHtml(l.name) + "</h3>" +
    "<p>" + escapeHtml(l.description) + "</p>" +
    "<p class='muted'>Seller: <code>" + escapeHtml(l.seller_account) + "</code> &middot; Price: <b>" + escapeHtml(l.price_near) + " NEAR</b> / call &middot; Listing: <code>" + escapeHtml(l.id) + "</code></p>";
  if (type === "scan") {
    html += "<label class='muted'>NEAR token contract account ID</label>" +
      "<input data-address value='" + SAMPLE_TOKEN + "' spellcheck='false' />" +
      "<p class='muted'>Try: <code>wrap.near</code> &middot; <code>usdt.tether-token.near</code> &middot; <code>token.v2.ref-finance.near</code></p>";
  } else if (type === "xray") {
    html += "<label class='muted'>NEAR account ID to X-ray</label>" +
      "<input data-address value='" + SAMPLE_ACCOUNT + "' spellcheck='false' />" +
      "<p class='muted'>Any mainnet (.near) or testnet (.testnet) account — try <code>wrap.near</code> or your own account.</p>";
  } else if (type === "namecheck") {
    html += "<label class='muted'>NEAR account name to check</label>" +
      "<input data-address value='" + SAMPLE_NAME + "' spellcheck='false' />" +
      "<p class='muted'>Any .near or .testnet name — try <code>satoshi.near</code> (taken) or a name you hope is free.</p>";
  }
  html += "<button data-demo class='demo'>&#9889; One-tap demo buy</button>" +
    "<div data-demoout></div>" +
    "<hr style='border:none;border-top:1px solid #eee;margin:1rem 0' />" +
    "<p class='muted'>...or buy manually with your own testnet account:</p>" +
    "<input placeholder='Your NEAR account (buyer), e.g. bob.testnet' data-buyer />" +
    "<button data-buy>Buy call</button>" +
    "<div data-flow></div>";
  div.innerHTML = html;

  function isNearIdStrict(a) {
    if (a.length < 2 || a.length > 64 || a !== a.toLowerCase()) return false;
    var segs = a.split(".");
    if (segs.length < 2) return false;
    return segs.every(function (s) { return /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(s); });
  }
  function isNearIdLoose(a) {
    if (a.length < 2 || a.length > 64) return false;
    if (/^[0-9a-f]{64}$/.test(a)) return true;
    if (a !== a.toLowerCase()) return false;
    return a.split(".").every(function (s) { return /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(s); });
  }

  function readInput() {
    if (type === "generic") return undefined;
    var a = div.querySelector("[data-address]").value.trim();
    if (type === "scan") {
      if (!isNearIdStrict(a)) {
        alert("Enter a valid NEAR token contract account ID, e.g. usdt.tether-token.near (lowercase, dot-separated).");
        return null;
      }
      return { contract: a };
    }
    if (!isNearIdLoose(a)) {
      alert("Enter a valid NEAR account ID, e.g. wrap.near or alice.testnet.");
      return null;
    }
    return { account: a };
  }

  var demoBtn = div.querySelector("[data-demo]");
  var demoOut = div.querySelector("[data-demoout]");
  demoBtn.onclick = function () {
    var input = readInput();
    if (type !== "generic" && input === null) return;
    demoBtn.disabled = true;
    demoOut.innerHTML = "<p class='muted'>Paying " + escapeHtml(l.price_near) + " testNEAR from the demo buyer wallet and running the call...</p>";
    var payload = { listing_id: l.id };
    if (input) payload.input = input;
    api("/api/demo/buy", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      demoOut.innerHTML = renderResult(r);
    }).catch(function (e) {
      demoOut.innerHTML = "<p style='color:#a00'>Demo buy failed: " + escapeHtml(e.message) + "</p>";
    }).then(function () { demoBtn.disabled = false; });
  };

  var buyBtn = div.querySelector("[data-buy]");
  var flow = div.querySelector("[data-flow]");
  buyBtn.onclick = function () {
    var buyer = div.querySelector("[data-buyer]").value.trim();
    if (!buyer) { alert("Enter your NEAR account first."); return; }
    var input = readInput();
    if (type !== "generic" && input === null) return;
    buyBtn.disabled = true;
    var payload = { listing_id: l.id, buyer_account: buyer };
    if (input) payload.input = input;
    api("/api/purchase", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (p) {
      flow.innerHTML =
        "<h4>Step 1 — pay on NEAR testnet</h4>" +
        "<ol class='instructions'>" + p.instructions.map(function (i) { return "<li>" + escapeHtml(i) + "</li>"; }).join("") + "</ol>" +
        "<p class='muted'>Payment id: <code>" + escapeHtml(p.id) + "</code></p>" +
        "<h4>Step 2 — claim your call</h4>" +
        "<input placeholder='Paste transaction hash' data-tx />" +
        "<button data-claim>Verify &amp; run call</button>" +
        "<div data-result></div>";
      flow.querySelector("[data-claim]").onclick = function (ev) {
        var btn = ev.target; btn.disabled = true;
        var tx = flow.querySelector("[data-tx]").value.trim();
        api("/api/purchase/" + p.id + "/claim", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ tx_hash: tx })
        }).then(function (r) {
          flow.querySelector("[data-result]").innerHTML = renderResult(r);
        }).catch(function (e) {
          flow.querySelector("[data-result]").innerHTML = "<p style='color:#a00'>Claim failed: " + escapeHtml(e.message) + "</p>";
        }).then(function () { btn.disabled = false; });
      };
    }).catch(function (e) {
      alert("Purchase failed: " + e.message);
    }).then(function () { buyBtn.disabled = false; });
  };

  return div;
}

refresh();
</script>
</body>
</html>
`;
