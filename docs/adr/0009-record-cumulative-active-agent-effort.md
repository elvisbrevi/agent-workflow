# Record cumulative active agent effort

Azure ticket `Real Effort` will record active implementation, testing, review, correction, and merge-verification time in hours rounded upward to `0.25 h`, excluding operator waits and provider retry backoff. Checkpoints preserve the uncommitted accumulated duration across retries, and publication adds it to any pre-existing field value exactly once rather than overwriting or double-counting it.
