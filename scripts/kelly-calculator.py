#!/usr/bin/env python3
"""
Kelly Criterion Calculator for Prediction Market Positions.

Calculates optimal sell/hold split for binary prediction market shares
using Full Kelly, Fractional Kelly, and Log-Utility models.

Usage:
    python kelly-calculator.py --shares 400 --entry 0.05 --market 0.52 --prob 0.70
    python kelly-calculator.py --shares 400 --entry 0.05 --market 0.52 --prob 0.70 --kelly-frac 0.25
"""

import argparse
import math


def kelly_fraction(p: float, m: float) -> float:
    """Full Kelly optimal fraction: f* = (p - m) / (1 - m)"""
    if p <= m:
        return 0.0
    return (p - m) / (1 - m)


def optimal_sell_kelly(shares: int, p: float, m: float, alpha: float = 1.0) -> int:
    """How many shares to sell based on (fractional) Kelly."""
    f = kelly_fraction(p, m) * alpha
    keep = round(shares * f)
    return shares - keep


def log_utility(x_sell: int, shares: int, p: float, m: float) -> float:
    """Expected log-utility when selling x_sell shares at price m."""
    cash = m * x_sell
    remaining = shares - x_sell
    win_wealth = cash + remaining * 1.0
    lose_wealth = cash + remaining * 0.0  # = cash

    if lose_wealth <= 0:
        return -float('inf')
    if win_wealth <= 0:
        return -float('inf')

    return p * math.log(win_wealth) + (1 - p) * math.log(lose_wealth)


def optimal_sell_log_utility(shares: int, p: float, m: float) -> int:
    """Find sell amount that maximizes expected log-utility (brute force over integers)."""
    best_x = 0
    best_u = -float('inf')
    # Must sell at least 1 share to have nonzero lose_wealth
    for x in range(1, shares + 1):
        u = log_utility(x, shares, p, m)
        if u > best_u:
            best_u = u
            best_x = x
    return best_x


def ev_hold_all(shares: int, p: float) -> float:
    return shares * p


def ev_sell_all(shares: int, m: float) -> float:
    return shares * m


def analyze(shares: int, entry: float, market: float, prob: float, kelly_frac: float):
    cost_basis = shares * entry
    current_value = shares * market
    unrealized_pnl = current_value - cost_basis

    print("=" * 60)
    print("  KELLY CRITERION — PREDICTION MARKET CALCULATOR")
    print("=" * 60)

    print(f"\n{'POSITION':>20}")
    print(f"{'Shares':>20}: {shares}")
    print(f"{'Entry price':>20}: ${entry:.4f}")
    print(f"{'Current price':>20}: ${market:.4f}")
    print(f"{'Cost basis':>20}: ${cost_basis:.2f}")
    print(f"{'Current value':>20}: ${current_value:.2f}")
    print(f"{'Unrealized P&L':>20}: ${unrealized_pnl:.2f} ({unrealized_pnl/cost_basis*100:.0f}%)")

    print(f"\n{'PARAMETERS':>20}")
    print(f"{'Your prob (p)':>20}: {prob:.0%}")
    print(f"{'Market price (m)':>20}: {market:.0%}")
    print(f"{'Edge (p - m)':>20}: {prob - market:+.0%}")
    print(f"{'Kelly multiplier':>20}: {kelly_frac}x")

    if prob <= market:
        print(f"\n  ⚠  Your p ({prob:.0%}) <= market price ({market:.0%})")
        print(f"     Kelly says: SELL EVERYTHING. You have no edge.")
        print(f"     Cash out: ${current_value:.2f}")
        print("=" * 60)
        return

    # Full Kelly
    f_full = kelly_fraction(prob, market)
    sell_full = optimal_sell_kelly(shares, prob, market, alpha=1.0)
    keep_full = shares - sell_full

    # Fractional Kelly
    sell_frac = optimal_sell_kelly(shares, prob, market, alpha=kelly_frac)
    keep_frac = shares - sell_frac

    # Log-utility optimal
    sell_log = optimal_sell_log_utility(shares, prob, market)
    keep_log = shares - sell_log

    print(f"\n{'─' * 60}")
    print(f"  MODEL RESULTS")
    print(f"{'─' * 60}")

    models = [
        ("Full Kelly (1.0x)", sell_full, keep_full),
        (f"Frac Kelly ({kelly_frac}x)", sell_frac, keep_frac),
        ("Log-Utility", sell_log, keep_log),
    ]

    header = f"  {'Model':<22} {'Sell':>6} {'Keep':>6} {'Cash':>9} {'If Win':>9} {'If Lose':>9}"
    print(header)
    print(f"  {'─'*22} {'─'*6} {'─'*6} {'─'*9} {'─'*9} {'─'*9}")

    for name, sell, keep in models:
        cash = sell * market
        win_total = cash + keep * 1.0
        lose_total = cash
        print(f"  {name:<22} {sell:>6} {keep:>6} ${cash:>7.2f} ${win_total:>7.2f} ${lose_total:>7.2f}")

    # Also show hold-all and sell-all for comparison
    print(f"  {'─'*22} {'─'*6} {'─'*6} {'─'*9} {'─'*9} {'─'*9}")
    print(f"  {'Hold All':<22} {0:>6} {shares:>6} {'$0.00':>9} ${shares*1.0:>7.2f} ${'0.00':>6}")
    print(f"  {'Sell All':<22} {shares:>6} {0:>6} ${shares*market:>7.2f} ${shares*market:>7.2f} ${shares*market:>7.2f}")

    print(f"\n{'─' * 60}")
    print(f"  EXPECTED VALUES")
    print(f"{'─' * 60}")

    for name, sell, keep in models:
        cash = sell * market
        ev = cash + keep * prob
        variance = (keep ** 2) * prob * (1 - prob)
        std = math.sqrt(variance)
        print(f"  {name:<22}  EV = ${ev:>7.2f}   StdDev = ${std:>7.2f}")

    ev_hold = ev_hold_all(shares, prob)
    ev_sell = ev_sell_all(shares, market)
    print(f"  {'Hold All':<22}  EV = ${ev_hold:>7.2f}   StdDev = ${math.sqrt(shares**2 * prob*(1-prob)):>7.2f}")
    print(f"  {'Sell All':<22}  EV = ${ev_sell:>7.2f}   StdDev = ${'0.00':>6}")

    print(f"\n{'─' * 60}")
    print(f"  KELLY MATH DETAIL")
    print(f"{'─' * 60}")
    print(f"  f* = (p - m) / (1 - m) = ({prob} - {market}) / (1 - {market}) = {f_full:.4f}")
    print(f"  Optimal bankroll allocation: {f_full:.1%} (full) / {f_full*kelly_frac:.1%} (fractional)")
    print(f"  Bankroll = current position value = ${current_value:.2f}")
    print(f"  Keep value = ${current_value * f_full * kelly_frac:.2f} → {keep_frac} shares")
    print(f"  Sell value = ${current_value * (1 - f_full * kelly_frac):.2f} → {sell_frac} shares")

    print("\n" + "=" * 60)


def main():
    parser = argparse.ArgumentParser(description="Kelly Criterion calculator for prediction markets")
    parser.add_argument("--shares", type=int, required=True, help="Number of shares held")
    parser.add_argument("--entry", type=float, required=True, help="Entry price per share")
    parser.add_argument("--market", type=float, required=True, help="Current market price per share")
    parser.add_argument("--prob", type=float, required=True, help="Your estimated true probability (0-1)")
    parser.add_argument("--kelly-frac", type=float, default=0.5, help="Kelly fraction multiplier (default: 0.5 = half-Kelly)")
    args = parser.parse_args()

    if not (0 < args.prob <= 1):
        parser.error("--prob must be between 0 and 1")
    if not (0 < args.market < 1):
        parser.error("--market must be between 0 and 1")
    if args.shares <= 0:
        parser.error("--shares must be positive")

    analyze(args.shares, args.entry, args.market, args.prob, args.kelly_frac)


if __name__ == "__main__":
    main()
