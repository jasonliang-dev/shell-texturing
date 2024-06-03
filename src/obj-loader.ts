export interface OBJLoadResult {
  vertices: number[];
  normals: number[];
  texcoords: number[];
  faces: number[];
}

function isWhitespace(c: string) {
  return c === " " || c === "\r";
}

export default class OBJLoader {
  private file = "";
  private contents = "";
  private end = 0;
  private line = 1;

  public static async load(file: string) {
    const loader = new OBJLoader();

    loader.file = file;
    loader.contents = await fetch(file).then((r) => r.text());

    const out: OBJLoadResult = {
      vertices: [],
      normals: [],
      texcoords: [],
      faces: [],
    };

    while (!loader.atEnd()) {
      loader.scanNext(out);
    }

    return out;
  }

  private atEnd() {
    return this.end === this.contents.length;
  }

  private next() {
    if (!this.atEnd()) {
      this.end++;
    }
  }

  private peek() {
    return this.contents[this.end];
  }

  private expect(c: string) {
    if (this.atEnd()) {
      throw `expected '${c}' on line ${this.line}`;
    }

    const other = this.contents[this.end];
    if (other !== c) {
      throw `expected '${c}' on line ${this.line} got '${other}'`;
    }

    this.next();
  }

  private skipWhitespace() {
    while (!this.atEnd() && isWhitespace(this.peek())) {
      this.next();
    }
  }

  private seekToEndOfLine() {
    while (!this.atEnd() && this.peek() !== "\n") {
      this.next();
    }

    this.next();
    this.line++;
  }

  private scanToken() {
    const start = this.end;

    while (!this.atEnd()) {
      const c = this.peek();
      if (isWhitespace(c) || c === "\n") {
        break;
      }
      this.next();
    }

    return this.contents.substring(start, this.end);
  }

  private scanNumber() {
    this.skipWhitespace();

    const start = this.end;

    while (!this.atEnd()) {
      const c = this.peek();
      const isNum =
        c === "-" ||
        c === "." ||
        (c >= "0" && c <= "9") ||
        c === "E" ||
        c === "e";
      if (!isNum) {
        break;
      }
      this.next();
    }

    const str = this.contents.substring(start, this.end);
    return Number.parseFloat(str);
  }

  private scanVertex(out: OBJLoadResult) {
    out.vertices.push(this.scanNumber());
    out.vertices.push(this.scanNumber());
    out.vertices.push(this.scanNumber());
  }

  private scanVertexNormal(out: OBJLoadResult) {
    out.normals.push(this.scanNumber());
    out.normals.push(this.scanNumber());
    out.normals.push(this.scanNumber());
  }

  private scanVertexTexture(out: OBJLoadResult) {
    out.texcoords.push(this.scanNumber());
    out.texcoords.push(this.scanNumber());
  }

  private scanTriple(out: OBJLoadResult) {
    out.faces.push(this.scanNumber());
    this.expect("/");
    out.faces.push(this.scanNumber());
    this.expect("/");
    out.faces.push(this.scanNumber());
  }

  private scanFace(out: OBJLoadResult) {
    this.scanTriple(out);
    this.scanTriple(out);
    this.scanTriple(out);

    if (this.peek() === "\r") {
      this.next();
    }

    if (this.peek() !== "\n") {
      let v0 = out.faces.length - 9;
      out.faces.push(out.faces[v0 + 0]);
      out.faces.push(out.faces[v0 + 1]);
      out.faces.push(out.faces[v0 + 2]);

      out.faces.push(out.faces[v0 + 6]);
      out.faces.push(out.faces[v0 + 7]);
      out.faces.push(out.faces[v0 + 8]);

      this.scanTriple(out);
    }
  }

  private scanNext(out: OBJLoadResult) {
    if (this.atEnd()) {
      return;
    }

    this.skipWhitespace();

    const tok = this.scanToken();
    this.next();

    if (tok === "") {
      this.line++;
      return;
    }

    switch (tok) {
      case "#":
        break;
      case "v":
        this.scanVertex(out);
        break;
      case "vn":
        this.scanVertexNormal(out);
        break;
      case "vt":
        this.scanVertexTexture(out);
        break;
      case "f":
        this.scanFace(out);
        break;
      case "g":
        break;
      case "o":
        break;
      case "s":
        break;
      case "usemtl":
        break;
      case "mtllib":
        break;
      default:
        if (tok.length === 1) {
          throw `unknown token '${tok}' (${tok.charCodeAt(0)}) on line ${this.line} in ${this.file}`;
        } else {
          throw `unknown token '${tok}' on line ${this.line} in ${this.file}`;
        }
    }

    this.seekToEndOfLine();
  }
}
