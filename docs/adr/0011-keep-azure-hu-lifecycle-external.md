# Keep the Azure HU lifecycle external

`issue-killer` will treat an Azure delivery HU as an integration container rather than as the work item it completes. A successful Azure HU run ends when every selected direct-child ticket is `Done` and integrated into the HU branch; it neither closes the HU nor creates or merges a final PR from that branch into `master`, `develop`, or another repository mainline. This deliberately differs from GitHub issue completion and preserves external ownership of HU acceptance and promotion.
