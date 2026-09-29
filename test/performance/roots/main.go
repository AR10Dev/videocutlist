// Command roots encodes disposable benchmark media roots for server configuration.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) != 2 && len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: roots BENCH_DIR [FIXTURE_DIR]")
		os.Exit(2)
	}
	roots := map[string]string{"bench": os.Args[1]}
	if len(os.Args) == 3 {
		roots["fixture"] = os.Args[2]
	}
	if err := json.NewEncoder(os.Stdout).Encode(roots); err != nil {
		fmt.Fprintln(os.Stderr, "encode benchmark roots:", err)
		os.Exit(1)
	}
}
