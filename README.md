# chain-repo-updater

To install dependencies:

```sh
bun install
```

To run:

```sh
bun run mainnet
bun run chipnet
bun run testnet4
bun run testnet3
```

Hex dump a block:

```sh
$ xxd blocks/0/0/0_000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f.block

00000000: 0100 0000 0000 0000 0000 0000 0000 0000  ................
00000010: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000020: 0000 0000 3ba3 edfd 7a7b 12b2 7ac7 2c3e  ....;...z{..z.,>
00000030: 6776 8f61 7fc8 1bc3 888a 5132 3a9f b8aa  gv.a......Q2:...
00000040: 4b1e 5e4a 29ab 5f49 ffff 001d 1dac 2b7c  K.^J)._I......+|
00000050: 0101 0000 0001 0000 0000 0000 0000 0000  ................
00000060: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000070: 0000 0000 0000 ffff ffff 4d04 ffff 001d  ..........M.....
00000080: 0104 4554 6865 2054 696d 6573 2030 332f  ..EThe Times 03/
00000090: 4a61 6e2f 3230 3039 2043 6861 6e63 656c  Jan/2009 Chancel
000000a0: 6c6f 7220 6f6e 2062 7269 6e6b 206f 6620  lor on brink of
000000b0: 7365 636f 6e64 2062 6169 6c6f 7574 2066  second bailout f
000000c0: 6f72 2062 616e 6b73 ffff ffff 0100 f205  or banks........
000000d0: 2a01 0000 0043 4104 678a fdb0 fe55 4827  *....CA.g....UH'
000000e0: 1967 f1a6 7130 b710 5cd6 a828 e039 09a6  .g..q0..\..(.9..
000000f0: 7962 e0ea 1f61 deb6 49f6 bc3f 4cef 38c4  yb...a..I..?L.8.
00000100: f355 04e5 1ec1 12de 5c38 4df7 ba0b 8d57  .U......\8M....W
00000110: 8a4c 702b 6bf1 1d5f ac00 0000 00         .Lp+k.._.....
```
