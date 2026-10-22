import json
import sys
from pathlib import Path

from okf_workspace.semantic.store import SemanticOperationStore

request = SemanticOperationStore(Path(sys.argv[1])).claim_next(sys.argv[2])
print(json.dumps(request.operation_id if request is not None else None))
