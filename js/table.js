// Our lovely bones
const tplBase = "<table><tbody>{row}</tbody></table>";
const tplRow = "<tr>{cell}</tr>";
const tplCell = "<td id=\"{id}\">{content}</td>"

// Manage tables. Like a bawss.
class table {
  constructor(parent, rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.map = [[]];
    this.cells = rows * cols;

    /**
      Anatomy of the idMap  (row, col)
            Col
      [      V
        [{},{},{}],
Row ->  [{},{},{}],
        [{},{},{SEE CELL}]
      ]
    */

    var tablehtml = this.makeHtml(rows, cols, true);
    $('#'+parent).html(tablehtml);
  }

  set(r, c, html) {
    if(r < this.rows && c < this.cols && r >= 0  && c >= 0 ) {
      o(r, c, this).html(html);
    }
  }

  makeID() {
    return Number(Math.random().toString().substr(2)).toString(32);
  }

  getID(r, c) {
    return this.map[r][c].id;
  }

  idLinear(n) {
    var rc = this.coords(n);
    return rc.r >= 0 ? this.map[rc.r][rc.c].id : '';
  }

  setLinear(n, html) {
    var rc = this.coords(n);
    this.set(rc.r, rc.c, html);
  }

  coords(n) {
    var r = Math.floor(n / this.cols);
    var c = n % this.cols;
    if(r < this.rows && c < this.cols && r >= 0  && c >= 0 ) {
      return {r,c};
    }
    return {r: -1, c: -1};
  }

  addRow(newNum, count) {

  }

  delRow(num, count) {

  }

  addCol(newNum, count) {

  }

  delCol(num, count) {

  }

  makeHtml(rows, cols, buildMap) {
    var map = [[]]; // an empty table
    var html = tplBase.replace('{row}', tplRow.repeat(rows))
      .replace(/{cell}/g, tplCell.repeat(cols))
    for(let r = 0; r < rows; r++) {
      // map[r].push([]);
      for(let c = 0; c < cols; c++) {
        map.push([]);
        let id = this.makeID();
        html = html.replace(/\{id\}/, id)
          .replace(/\{content\}/, '');
          map[r][c] = {};
        map[r][c].id = id;
        map[r][c].r = +r;
        map[r][c].c = +c;
      }
    }
    if(buildMap) {
      this.map = map;
    }
    return html;
  }
}

// Get a DOM object for any cell in the given table object
// Supar sugar function
function o(r, c, table) {
  return $('#'+table.map[r][c].id);
}
