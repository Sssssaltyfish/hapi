import sys
from pathlib import Path

lines = Path(sys.argv[1]).read_text().split('\n')
for position in sys.argv[2:]:
    line, column = map(int, position.split(':'))
    print(position, lines[line - 1][max(0, column - 140):column + 230])
