// A delta from before its rpc mode: it refuses the options Rivet starts it with, as argparse does.
process.stderr.write("usage: delta [-h] [--version] [--print] [--model MODEL] [prompt]\ndelta: error: unrecognized arguments: --mode rpc --cwd .\n");
process.exit(2);
