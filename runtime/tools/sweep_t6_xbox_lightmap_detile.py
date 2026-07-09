#!/usr/bin/env python3
"""Sweep Xbox 360 BC3 lightmap detile variants against local PNG oracles.

This is intentionally bounded to the extracted lightmap bins and PC verification
PNGs under runtime/xbox_transit_calib. It does not read the full DAT.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class AddressVariant:
    name: str
    micro_mask: int
    y8_term: bool
    y16_term: bool
    bank_term: bool


ADDRESS_VARIANTS = [
    AddressVariant("xg_umodel_y0e", 0x0E, False, True, True),
    AddressVariant("xg_xdk_y06_y8", 0x06, True, True, True),
    AddressVariant("xg_y06_no_y8", 0x06, False, True, True),
    AddressVariant("xg_y0e_y8", 0x0E, True, True, True),
    AddressVariant("xg_y0e_no_bank", 0x0E, False, True, False),
    AddressVariant("xg_y06_y8_no_bank", 0x06, True, True, False),
    AddressVariant("xg_y0e_no_y16", 0x0E, False, False, True),
    AddressVariant("xg_y06_y8_no_y16", 0x06, True, False, True),
]


SWAP_MODES = [
    "none",
    "pair16_all",
    "pair16_color",
    "pair16_color_endpoints",
    "pair16_alpha",
    "word_order_reverse",
    "block_reverse",
]


def parse_int(value: str) -> int:
    return int(value, 0)


def rgb565(value: int) -> tuple[float, float, float]:
    r = ((value >> 11) & 31) * 255.0 / 31.0
    g = ((value >> 5) & 63) * 255.0 / 63.0
    b = (value & 31) * 255.0 / 31.0
    return r, g, b


def apply_swap(block: bytes, mode: str) -> bytes:
    b = bytearray(block)
    if mode == "none":
        return bytes(b)
    if mode == "pair16_all":
        ranges = [(0, 16)]
    elif mode == "pair16_color":
        ranges = [(8, 16)]
    elif mode == "pair16_color_endpoints":
        ranges = [(8, 12)]
    elif mode == "pair16_alpha":
        ranges = [(0, 8)]
    elif mode == "word_order_reverse":
        words = [b[i : i + 2] for i in range(0, 16, 2)]
        return bytes(sum(words[::-1], bytearray()))
    elif mode == "block_reverse":
        b.reverse()
        return bytes(b)
    else:
        raise ValueError(mode)

    for start, end in ranges:
        for i in range(start, end, 2):
            b[i], b[i + 1] = b[i + 1], b[i]
    return bytes(b)


def block_luma(block: bytes, swap_mode: str) -> float:
    b = apply_swap(block, swap_mode)
    c0 = int.from_bytes(b[8:10], "little")
    c1 = int.from_bytes(b[10:12], "little")
    c = [rgb565(c0), rgb565(c1)]
    c.append(tuple((2 * c[0][i] + c[1][i]) / 3.0 for i in range(3)))
    c.append(tuple((c[0][i] + 2 * c[1][i]) / 3.0 for i in range(3)))
    lum = np.array([0.2126 * r + 0.7152 * g + 0.0722 * bl for r, g, bl in c], dtype=np.float64)
    bits = int.from_bytes(b[12:16], "little")
    counts = np.zeros(4, dtype=np.float64)
    for i in range(16):
        counts[(bits >> (i * 2)) & 3] += 1.0
    return float(np.dot(counts, lum) / 16.0)


def all_block_lumas(payload: bytes, swap_mode: str) -> np.ndarray:
    blocks = len(payload) // 16
    out = np.empty(blocks, dtype=np.float64)
    for i in range(blocks):
        out[i] = block_luma(payload[i * 16 : (i + 1) * 16], swap_mode)
    return out


def oracle_block_luma(path: Path, width: int, height: int) -> np.ndarray:
    img = Image.open(path).convert("RGBA")
    if img.size != (width, height):
        raise ValueError(f"{path}: expected {width}x{height}, got {img.size[0]}x{img.size[1]}")
    arr = np.asarray(img, dtype=np.float64)[..., :3]
    gray = 0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]
    bh = height // 4
    bw = width // 4
    return gray.reshape(bh, 4, bw, 4).mean(axis=(1, 3)).reshape(-1)


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    aa = a.astype(np.float64, copy=False)
    bb = b.astype(np.float64, copy=False)
    aa = aa - aa.mean()
    bb = bb - bb.mean()
    den = math.sqrt(float(np.dot(aa, aa) * np.dot(bb, bb)))
    return 0.0 if den == 0.0 else float(np.dot(aa, bb) / den)


def tiled_index(
    x: int,
    y: int,
    pitch_blocks: int,
    bpb: int,
    variant: AddressVariant,
    align_blocks: int,
) -> int:
    log_bpb = int(math.log2(bpb))
    aligned_width = (pitch_blocks + (align_blocks - 1)) & ~(align_blocks - 1)
    macro = ((x >> 5) + (y >> 5) * (aligned_width >> 5)) << (log_bpb + 7)
    micro = ((x & 7) + ((y & variant.micro_mask) << 2)) << log_bpb
    off = macro + ((micro & ~0x0F) << 1) + (micro & 0x0F) + ((y & 1) << 4)
    if variant.y8_term:
        off += (y & 8) << (3 + log_bpb)

    out = ((off & ~0x1FF) << 3) + ((off & 0x1C0) << 2) + (off & 0x3F)
    if variant.y16_term:
        out += (y & 16) << 7
    if variant.bank_term:
        out += (((((y & 8) >> 2) + (x >> 3)) & 3) << 6)
    return out >> log_bpb


def permutation(
    width: int,
    height: int,
    layout: str,
    pitch_blocks: int,
    address: AddressVariant | None,
    align_blocks: int,
    total_blocks: int,
) -> tuple[np.ndarray, float, float]:
    bw = width // 4
    bh = height // 4
    if layout == "linear":
        idx = np.arange(bw * bh, dtype=np.int64)
    else:
        if address is None:
            raise ValueError("tiled layout needs address variant")
        if layout == "whole":
            slice_h = bh
        elif layout.startswith("slices:"):
            slice_h = int(layout.split(":", 1)[1])
            if bh % slice_h != 0:
                raise ValueError(f"{layout} does not divide block height {bh}")
        else:
            raise ValueError(layout)

        idx = np.empty(bw * bh, dtype=np.int64)
        out_i = 0
        slice_blocks = bw * slice_h
        for y in range(bh):
            slice_i = y // slice_h
            ly = y % slice_h
            slice_base = slice_i * slice_blocks
            for x in range(bw):
                idx[out_i] = slice_base + tiled_index(x, ly, pitch_blocks, 16, address, align_blocks)
                out_i += 1

    valid = (idx >= 0) & (idx < total_blocks)
    if valid.all():
        unique_frac = len(np.unique(idx)) / len(idx)
    else:
        unique_frac = len(np.unique(idx[valid])) / len(idx)
    return idx, float(valid.mean()), float(unique_frac)


def score_variant(
    source_luma: np.ndarray,
    oracle_luma: np.ndarray,
    idx: np.ndarray,
    valid_fraction: float,
) -> float:
    if valid_fraction == 1.0:
        decoded = source_luma[idx]
    else:
        decoded = np.full(len(idx), float(source_luma.mean()), dtype=np.float64)
        valid = (idx >= 0) & (idx < len(source_luma))
        decoded[valid] = source_luma[idx[valid]]
    return ncc(decoded, oracle_luma)


def candidate_pitches(width_blocks: int) -> list[int]:
    values = {
        width_blocks,
        max(32, width_blocks // 4),
        max(32, width_blocks // 2),
        max(32, width_blocks * 3 // 4),
        width_blocks + 16,
        width_blocks + 32,
        width_blocks * 2,
    }
    for v in [32, 64, 96, 128, 160, 192, 224, 240, 248, 252, 256, 260, 264, 272, 288, 320, 384, 512, 768, 1024]:
        values.add(v)
    return sorted(v for v in values if v > 0)


def sweep_one(label: str, bin_path: Path, oracle_path: Path, width: int, height: int, top: int) -> list[dict]:
    payload = bin_path.read_bytes()
    blocks = len(payload) // 16
    bw = width // 4
    bh = height // 4
    if blocks != bw * bh:
        raise ValueError(f"{label}: {bin_path} has {blocks} BC3 blocks, dims require {bw * bh}")

    oracle = oracle_block_luma(oracle_path, width, height)
    source_by_swap = {mode: all_block_lumas(payload, mode) for mode in SWAP_MODES}

    layouts = ["linear", "whole"]
    for slice_h in [16, 32, 64, 128, 256, 384]:
        if bh % slice_h == 0 and slice_h != bh:
            layouts.append(f"slices:{slice_h}")

    results: list[dict] = []
    for layout in layouts:
        if layout == "linear":
            address_iter = [None]
            pitch_iter = [bw]
            align_iter = [32]
        else:
            address_iter = ADDRESS_VARIANTS
            pitch_iter = candidate_pitches(bw)
            align_iter = [16, 32, 64]

        for address in address_iter:
            for pitch in pitch_iter:
                for align in align_iter:
                    addr_name = address.name if address else "linear"
                    try:
                        idx, valid_fraction, unique_fraction = permutation(width, height, layout, pitch, address, align, blocks)
                    except ValueError:
                        continue
                    # Skip degenerate pitch/align choices that cannot possibly represent the full payload.
                    if valid_fraction < 0.90 or unique_fraction < 0.90:
                        continue
                    for swap in SWAP_MODES:
                        score = score_variant(source_by_swap[swap], oracle, idx, valid_fraction)
                        results.append(
                            {
                                "label": label,
                                "ncc": score,
                                "layout": layout,
                                "widthBlocks": bw,
                                "heightBlocks": bh,
                                "pitchBlocks": pitch,
                                "alignBlocks": align,
                                "address": addr_name,
                                "swap": swap,
                                "validFraction": valid_fraction,
                                "uniqueFraction": unique_fraction,
                            }
                        )

    results.sort(key=lambda r: r["ncc"], reverse=True)
    print(f"\n== {label} top {top} ==")
    for row in results[:top]:
        print(
            f"NCC={row['ncc']:.6f} layout={row['layout']} pitch={row['pitchBlocks']} "
            f"align={row['alignBlocks']} addr={row['address']} swap={row['swap']} "
            f"valid={row['validFraction']:.3f} unique={row['uniqueFraction']:.3f}"
        )
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--out", default=str(ROOT / "xbox_transit_calib" / "stage3_lighting" / "lightmaps" / "detile_sweep_transit_s3.json"))
    args = parser.parse_args()

    cases = [
        (
            "lm0",
            ROOT / "xbox_transit_calib" / "xbox_transit_lm0_tiled.bin",
            ROOT / "xbox_transit_calib" / "stage3_lighting" / "lightmaps" / "pc_verify_lm0_secondary.png",
            1024,
            3072,
        ),
        (
            "lm1_metadata_512x3072",
            ROOT / "xbox_transit_calib" / "xbox_transit_lm1_tiled.bin",
            ROOT / "xbox_transit_calib" / "stage3_lighting" / "lightmaps" / "pc_verify_lm1_secondary.png",
            512,
            3072,
        ),
    ]

    report = {
        "tool": "sweep_t6_xbox_lightmap_detile.py",
        "source": "Xbox lightmap bins only; PC PNGs are verification oracles only.",
        "derived": {
            "format": "xenosFormat 20 / 0x54000000 = BC3/DXT5",
            "bytesPerBlock": 16,
            "lm0": {"width": 1024, "height": 3072, "widthBlocks": 256, "heightBlocks": 768, "resourceSize": "0x300000"},
            "lm1": {"width": 512, "height": 3072, "widthBlocks": 128, "heightBlocks": 768, "resourceSize": "0x180000"},
        },
        "results": {},
    }

    for case in cases:
        label, bin_path, oracle_path, width, height = case
        results = sweep_one(label, bin_path, oracle_path, width, height, args.top)
        report["results"][label] = results[: max(args.top, 50)]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nreport={out}")


if __name__ == "__main__":
    main()
