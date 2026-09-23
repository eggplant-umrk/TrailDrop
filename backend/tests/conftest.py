import pathlib
import sys

# main.py/models.py/route_analysis.py use absolute imports (no package prefix),
# so backend/ must be on sys.path for `import main` etc. to work from tests/.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
