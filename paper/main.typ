// Building a chess opening repertoire under a memory budget.
// Compile with: typst compile paper/main.typ

#import "@preview/cetz:0.4.2"
#import "@preview/cetz-plot:0.1.3": plot

// ---- Page and text -----------------------------------------------------------

#set document(
  title: "Building a chess opening repertoire under a memory budget",
  author: "Claude Opus 5.5 (Anthropic)",
)
#set page(paper: "a4", margin: (x: 2.6cm, y: 2.8cm), numbering: "1")
#set text(size: 11pt, lang: "en")
#set par(justify: true, leading: 0.62em, spacing: 1.1em)
#set heading(numbering: "1.1")
#show heading: set block(above: 1.6em, below: 0.9em)
#set math.equation(numbering: "(1)")
// Inline formulas are never split across lines.
#show math.equation.where(block: false): box
#show link: set text(fill: rgb("#1f4e79"))
// References to equations as "(9)", as is customary.
#show ref: it => {
  let el = it.element
  if el != none and el.func() == math.equation {
    link(el.location(), numbering("(1)", ..counter(math.equation).at(el.location())))
  } else {
    it
  }
}

// ---- Notation ------------------------------------------------------------------

#let EE = $upright(bold(E))$
#let PP = $upright(bold(P))$
#let Nown = $N_sigma$
#let Nopp = $N_omega$
#let accent = rgb("#b03a2e")

// ---- Theorem-like environments: one counter, referable with~@label ------------

#let thm-kind = "thm"
#show figure.where(kind: thm-kind): set block(breakable: true)
#show figure.where(kind: thm-kind): it => block(width: 100%, above: 1.2em, below: 1.2em, align(left)[
  *#it.supplement #it.counter.display(it.numbering)*#if it.caption != none [ (#it.caption.body)]*.*
  #it.body
])
#let env(supplement, italic) = (body, title: none) => figure(
  kind: thm-kind,
  supplement: supplement,
  numbering: "1",
  caption: if title == none { none } else { title },
  outlined: false,
  if italic { emph(body) } else { body },
)
#let theorem = env([Theorem], true)
#let proposition = env([Proposition], true)
#let lemma = env([Lemma], true)
#let corollary = env([Corollary], true)
#let definition = env([Definition], false)
#let hypothesis = env([Hypothesis], false)
#let example = env([Example], false)
#let remark = env([Remark], false)
#let proof(body) = block(width: 100%)[_Proof._ #body #h(1fr) $square$]

#show figure.where(kind: image): set figure.caption(position: bottom)
#show figure.caption: set text(size: 9.5pt)

// ---- Title -----------------------------------------------------------------------

#align(center)[
  #block(text(size: 16pt, weight: "bold")[Building a chess opening repertoire\ under a memory budget])
  #v(0.4em)
  #text(size: 11pt)[Claude Opus 5.5 (Anthropic)]
  #v(0.2em)
  #text(size: 9.5pt)[October 2026]
]

#v(1em)

#pad(x: 1.5cm)[
  #set text(size: 9.5pt)
  #set par(justify: true)
  *Abstract.* A chess player who prepares an opening must decide which
  moves to memorize: a repertoire is a set of prepared answers, and memory
  is limited. We formulate this choice as an optimization problem. Games are
  modelled as a random walk on the game tree whose transition probabilities
  are the move frequencies observed in a large database of games; the
  player's prepared moves replace these frequencies at the positions they
  cover. Under explicit hypotheses on the behaviour of the opponents and of
  the player outside of preparation, the expected score of a repertoire is a
  sum over the opponent moves that leave it, weighted by the probability of
  reaching them. This representation makes the gain of an extension of the
  repertoire additive over these moves, which reduces the problem to a
  separable resource allocation problem. Solving it exactly requires data on
  a number of positions that grows exponentially with the budget; we
  describe instead a greedy algorithm, with a pruning rule that keeps it
  exact at each step while querying few positions, and a look-ahead variant.
  We show by an example that the greedy algorithm can be arbitrarily far from
  optimal, and illustrate its behaviour on real data.
]

#v(1em)

= Introduction

Opening preparation is a large part of a chess player's work. A player who
has the black pieces and expects the moves 1.e4 e5 must be ready for 2.Nf3,
but also, less often, for 2.f4, 2.Nc3, 2.d4 or 2.Bc4; after 2.Nf3 and a reply
of their own, again for several moves of the opponent, and so on. Since the
number of positions grows exponentially with the depth, no one can prepare
everything, and the question is which positions deserve a prepared move.

_Chess and mathematics._ Chess has attracted mathematicians for a long
time, first through combinatorial puzzles on the board. Euler studied the
knight's tour, a path of the knight visiting every square exactly
once~@euler1759, and the problem of placing eight queens so that no two attack
each other, posed by Max Bezzel in 1848, was considered by Gauss. Several
strong players were mathematicians: Emanuel Lasker, world champion from
1894 to 1921, held a doctorate in mathematics, and his work on ideals in
polynomial rings~@lasker1905 is the origin of the Lasker--Noether theorem;
Max Euwe, world champion from 1935 to 1937, was a teacher of mathematics,
and used the Thue--Morse sequence to show that the rules of his time allowed
infinite games~@euwe1929.

The game itself became an object of mathematics with Zermelo's lecture at
the International Congress of Mathematicians of 1912~@zermelo1913, often
counted as the first theorem of game theory. The statement now attached to
his name, refined by Kőnig and Kalmár (see~@schwalbe2001 for this history),
is that in a finite game of perfect information between two players, such as
chess, either one of the players can force a win or both can force at least
a draw. The proof is a backward induction on the game tree, the same
reasoning that underlies von Neumann's minimax theory~@vonneumann1928 and,
later, Bellman's dynamic programming, which Bellman himself proposed to apply
to chess~@bellman1965; retrograde analysis of this kind now produces complete
tables of optimal play for endgames with few pieces. The tree is however far
too large to be solved: Shannon, in the article that founded computer
chess~@shannon1950, estimated the number of positions at about~$10^43$, and
proposed instead to search the tree to a limited depth and to evaluate the
positions reached with a heuristic function. This program led to the victory
of Deep Blue over Kasparov in 1997 and, combined with learning from
self-play, to programs such as AlphaZero~@silver2018. Statistics entered the
game through the rating of players: the system of Elo~@elo1978, adopted by
the international federation in 1970, models the result of a game as a
function of the difference of the players' strengths, and Glickman's
refinement~@glickman1999 is used by Lichess, whose games provide the data of
this note.

The question studied here differs from Zermelo's and Shannon's in one
respect. Their opponent is perfect: the value of a position is a _minimum_
over the opponent's replies. A human player faces imperfect opponents whose
choices, in a given population, are well described statistically, and the
relevant value is an _expectation_ over the replies, weighted by how often
they are played. The tree is the same, and backward induction remains the
main tool.

_The question._ Two observations make the choice of a repertoire amenable
to mathematics. First, large databases of online games give, for every
position that occurs often enough, the frequency of each move in a
population of players and the results of the games in which it was played.
Second, the benefit of a prepared move is a product of two such
quantities: the probability that the game reaches the position where it is
played, and the increase of the expected score that it brings there, compared
with the average result of the population in that position. For instance, a
move that raises the expected score by 20 percentage points, against a reply
played in 0.1% of the games, raises the player's overall expected score by~$0.001 times 20 = 0.02$ points, whereas a move that raises it by only 3
points, against a reply played in half of the games, raises it by~$0.5 times 3 = 1.5$ points. This is made precise in @lem:gain.

The aim of this note is to describe, with precise definitions and
hypotheses, the model and the algorithm used by the program
`tools/optimal_repertoire.py` of the open-source application Lirep
(#link("https://lirep.org")[lirep.org]). Lirep, a web application to build
and practise opening repertoires, was written to test whether this
quantitative point of view is of practical use to players: it computes the
expected score of a repertoire from the database, as in~@sec:model, and the
program studied here suggests which moves to add to it. The algorithm is
elementary; the point is rather to make explicit what is being optimized,
under which assumptions the objective has a meaning, and where the algorithm
is or is not optimal. The note is organized as follows. @sec:model
introduces game trees, repertoires and the probabilistic model, and proves a
formula for the expected score of a repertoire. @sec:data discusses its
estimation from data. @sec:problem states the optimization problem and
proves a decomposition result. @sec:greedy presents the greedy algorithm,
its pruning rule, an example where it fails, and a look-ahead variant.
@sec:numerics illustrates the method on real data, and~@sec:discussion
discusses the hypotheses.

= Game trees, repertoires and the expected score <sec:model>

== The game tree

We fix a starting position~$x_0$, for example the position after 1.e4 e5,
and one of the two sides, called _the player_ and denoted by~$sigma$; the
other side is _the opponent_, denoted by~$omega$.

#definition(title: [Game tree])[
  A _node_ is a finite sequence of moves played from~$x_0$, each of which
  is legal in the position reached by the previous ones; the empty sequence
  is the _root_, also denoted by~$x_0$. If~$x$ is a node and~$a$ a legal
  move after~$x$, we write~$x a$ for the node obtained by appending~$a$, and
  call~$(x, a)$ an _edge_ from~$x$ to its _child_ $x a$. A node is a
  _leaf_ if it has no child. The set~$T$ of nodes, ordered by
  the prefix relation, is a rooted tree, the _game tree_. We denote by
  #Nown (respectively #Nopp) the set of nodes, other than leaves, at which the
  player (respectively the opponent) is to move. For a node~$z$, we denote
  by~$T_z$ the subtree of nodes having~$z$ as a prefix.
]

A node is a _history_, not a position: two move orders reaching the same
position are distinct nodes. The game tree is finite, since the rules of
chess (fivefold repetition and the seventy-five-move rule) end every game
after finitely many moves. We will return in~@sec:data to the fact that
databases record positions rather than histories.

== Repertoires

The player memorizes at most one move at each node where it is their turn,
and may prepare answers to several, or all, of the opponent's replies at
each node where it is the opponent's turn: this is what makes a repertoire
a _strategy_ rather than a collection of lines.

#definition(title: [Repertoire])[
  A _repertoire_ is a map~$R$, defined on a finite set~$D subset Nown$ and
  assigning to each~$x in D$ a legal move~$R(x)$ at~$x$, such that every
  node of~$D$ is reached by following~$R$. Precisely, let
  $
    Y(R) = {x_0 : x_0 in Nopp} union {x R(x) : x in D}
  $
  be the set of opponent nodes reached by the repertoire (the root when the
  opponent moves first, and the node after each prepared move). We require
  that every~$x in D$ be either the root, or a child~$y m$ of a node~$y in Y(R)$; a node~$y in Y(R)$ may have any number of children in~$D$,
  one for each prepared reply. The _size_ of~$R$ is~$|R| = "card" D$, the number of
  memorized moves.
] <def:repertoire>

By induction on the length of~$x$, the condition means that for every~$x in D$, the path from~$x_0$ to~$x$ follows~$R$ at each of its player
nodes, all of which belong to~$D$.

A repertoire is therefore a subtree of~$T$ in which every player node has
exactly one child, while opponent nodes may have any number of children. An
opponent move~$m$ at~$y in Y(R)$ is _answered_ if~$y m in D$ and
_unanswered_ otherwise. The set of unanswered moves,
$
  U(R) = {(y, m) : y in Y(R), thick m "legal at" y, thick y m in.not D},
$
plays the central role in what follows: it is the set of edges through which
the game leaves the prepared part of the tree. @fig:tree shows a repertoire
for Black after 1.e4 e5 with five memorized moves.

#figure(
  {
    set text(size: 8pt)
    cetz.canvas(length: 1.05cm, {
      import cetz.draw: *
      let r = 0.16
      let opp(p, ..args) = circle(p, radius: r, fill: white, stroke: 0.7pt)
      let own(p) = rect(
        (p.at(0) - r, p.at(1) - r),
        (p.at(0) + r, p.at(1) + r),
        fill: luma(30),
        stroke: 0.7pt,
      )
      let out(p) = circle(p, radius: 0.07, fill: luma(150), stroke: none)
      // Edges go right from the parent, then vertically, then right to the
      // child; labels sit on the last, horizontal, segment.
      let elbow(a, b) = ((a.at(0) + 0.35, a.at(1)), (a.at(0) + 0.35, b.at(1)))
      let mid(a, b) = ((a.at(0) + 0.35 + b.at(0)) / 2, b.at(1))
      let reply(a, b, body) = {
        line(a, ..elbow(a, b), b, stroke: 0.6pt)
        content(mid(a, b), body, anchor: "south", padding: 2.5pt)
      }
      let unanswered(a, b, body) = {
        line(a, ..elbow(a, b), b, stroke: (paint: luma(120), thickness: 0.6pt, dash: "dashed"))
        content(b, text(fill: luma(90), body), anchor: "west", padding: 5pt)
      }
      let prepared(a, b, body) = {
        line(a, b, stroke: (paint: accent, thickness: 1.8pt))
        content(((a.at(0) + b.at(0)) / 2, a.at(1)), text(fill: accent, weight: "bold", body),
          anchor: "south", padding: 3pt)
      }

      let root = (0, 0)
      let nf3 = (3.0, 2.4)
      let f4 = (3.0, -1.2)
      let others0 = (3.0, -2.6)
      let d5 = (5.2, 2.4)
      let bc5 = (5.2, -1.2)
      let exd5 = (8.0, 3.6)
      let nxe5 = (8.0, 2.4)
      let others1 = (8.0, 1.3)
      let nf3b = (8.0, -0.2)
      let others2 = (8.0, -1.6)
      let nf6 = (10.2, 3.6)
      let qe7 = (10.2, 2.4)
      let d5b = (10.2, -0.2)

      reply(root, nf3, [2.Nf3 #h(0.3em) 0.700])
      reply(root, f4, [2.f4 #h(0.3em) 0.089])
      unanswered(root, others0, [2.Nc3, 2.d4, 2.Bc4, ...: 0.211])
      prepared(nf3, d5, [2...d5])
      prepared(f4, bc5, [2...Bc5])
      reply(d5, exd5, [3.exd5 #h(0.3em) 0.463])
      reply(d5, nxe5, [3.Nxe5 #h(0.3em) 0.334])
      unanswered(d5, others1, [3.d4, 3.Nc3, ...: 0.203])
      reply(bc5, nf3b, [3.Nf3 #h(0.3em) 0.944])
      unanswered(bc5, others2, [others: 0.056])
      prepared(exd5, nf6, [3...Nf6])
      prepared(nxe5, qe7, [3...Qe7])
      prepared(nf3b, d5b, [3...d5])

      for p in (root, d5, bc5, nf6, qe7, d5b) { opp(p) }
      for p in (nf3, f4, exd5, nxe5, nf3b) { own(p) }
      for p in (others0, others1, others2) { out(p) }
      content((root.at(0) - 0.25, root.at(1)), [1.e4 e5], anchor: "east")
      for p in (nf6, qe7, d5b) {
        content((p.at(0) + 0.3, p.at(1)), text(fill: luma(90))[line ends], anchor: "west")
      }
    })
  },
  caption: [
    A repertoire~$R$ for Black, with root~$x_0$ the node 1.e4 e5 and~$|R| = 5$.
    Circles are opponent nodes (White to move), black squares are player
    nodes (Black to move). Prepared moves are in red; each label of an
    opponent move gives its frequency~$q(y, m)$ in the database used in
    @sec:numerics (blitz and rapid games on Lichess in which the average rating of the
    two players is at least 2000). Dashed edges group unanswered moves, which
    belong to~$U(R)$; the unanswered replies after 3...Nf6, 3...Qe7 and
    3...d5, also in~$U(R)$, are not drawn. The set~$D$ consists of the five
    squares;~$Y(R)$ consists of the six circles.
  ],
) <fig:tree>

== The probabilistic model

The model describes the games of the player against opponents drawn from a
fixed population, for example the online games of players with a given
rating in a given time control.

#definition(title: [Population law])[
  The _population law_ is a probability measure~$PP$ on the set of leaves
  of~$T$ (the complete games starting from~$x_0$), together with, for each
  complete game, its result~$Z in {0, 1/2, 1}$ from the player's point of
  view (loss, draw, win). For a node~$x$, we write~$PP(x)$ for the
  probability that the game passes through~$x$, and, when~$PP(x) > 0$,
  $
    q(x, a) = PP(x a) / PP(x),
    quad
    s(x, a) = EE[Z | "the game passes through" x a],
  $
  and~$s(x) = EE[Z | "the game passes through" x]$. Thus~$q(x, dot)$ is the
  distribution of the move played at~$x$ in the population, and~$s(x, a)$
  is the _score_ of the move~$a$ at~$x$: the mean result, for the player, of
  the games in which it was played.
]

The result~$Z$ is a function of the complete game rather than of the final
position, since games also end by resignation, agreement or on time; the
reader may think of the end of the game, with its result, as a last move
drawn from the population law. Since the nodes are histories, the
conditional law of the continuation of a game, given that it passes through~$x$, is the law of the random walk started at~$x$ with transition
probabilities~$q$; we use this Markov property repeatedly.

We now describe the games of a player who has memorized a repertoire~$R$.
The model rests on two hypotheses.

#hypothesis(title: [Opponents])[
  At every opponent node~$x$, the opponent plays the move~$a$ with
  probability~$q(x, a)$. In particular, the opponents' choices do not depend
  on the player's repertoire.
] <hyp:opp>

#hypothesis(title: [Play outside of preparation])[
  At every player node~$x in.not D$, the player plays the move~$a$ with
  probability~$q(x, a)$, and the result of a game, given its moves, has the
  same law as in the population.
] <hyp:out>

@hyp:out says that outside of their preparation, the player performs like
the average member of the population who reached the same node. Under
@hyp:opp and~@hyp:out, the games of the player are distributed according to
the law~$PP_R$ of the random walk on~$T$ started at~$x_0$ with transitions
$
  k_R (x, a) = cases(
    1 & "if" x in D "and" a = R(x)",",
    0 & "if" x in D "and" a != R(x)",",
    q(x, a) quad & "if" x in.not D,
  )
$
and with the population's law of the result given the moves. We write~$EE_R$ for the expectation under~$PP_R$ and~$pi_R (x) = PP_R ("the game
passes through" x)$. For an edge~$e = (y, m)$, we write~$pi_R (e) = pi_R (y m)$
and~$s(e) = s(y, m)$. To ensure that all the quantities above are defined,
we assume throughout that~$PP(x) > 0$ for every~$x in D union Y(R)$, and
that no node of~$D union Y(R)$ is a leaf; in practice, prepared lines are
short and only moves that occur in the database are prepared.

#definition(title: [Value of a repertoire])[
  The _value_ of a repertoire~$R$ is~$V(R) = EE_R [Z]$, the expected score of
  the player under~@hyp:opp and~@hyp:out.
]

The following representation is the basis of everything that follows.

#proposition(title: [Expected score as a sum over unanswered moves])[
  Let~$R$ be a repertoire with~$D != emptyset$ or~$x_0 in Nopp$. Then the
  edges of~$U(R)$ are crossed by disjoint sets of games, one of them is
  crossed~$PP_R$-almost surely, and
  $
    V(R) = sum_(e in U(R)) pi_R (e) thin s(e),
    quad quad
    sum_(e in U(R)) pi_R (e) = 1.
  $ <eq:value>
  Moreover, for~$e = (y, m) in U(R)$, the probability of crossing~$e$ is~$pi_R (e) = pi_R (y) q(y, m)$, where~$pi_R (y)$ is the product of the
  frequencies~$q$ of the opponent moves on the path from~$x_0$ to~$y$.
] <prop:value>

#proof[
  Under~$PP_R$, the game follows~$R$ at the nodes of~$D$ and the population
  frequencies at the opponent nodes. By the definition of a repertoire, as
  long as the game stays in~$D union Y(R)$, it alternates between a node~$y in Y(R)$ and, if the opponent's move~$m$ is answered, a node~$y m in D$ followed by~$y m R(y m) in Y(R)$. Since~$D$ is finite and no
  node of~$D union Y(R)$ is a leaf, the game almost surely reaches a node~$y in Y(R)$ at which the opponent plays an unanswered move~$m$, and it
  does so only once, since the descendants of~$y m$ are not in~$D$ (every
  node of~$D$ has all its player-ancestors in~$D$). This proves that the
  events {the game crosses~$e$},~$e in U(R)$, form a partition up to a null
  set, hence the second identity. The product formula for~$pi_R$ follows
  from the definition of~$k_R$, since the player's moves on the path have
  probability one.

  Fix~$e = (y, m) in U(R)$ with~$pi_R (e) > 0$. No descendant of~$y m$ is in~$D$, so after crossing~$e$ the walk under~$PP_R$ uses the transitions~$q$
  only. By the Markov property, the conditional law under~$PP_R$ of the
  continuation given that the game crosses~$e$ is equal to the conditional
  law under~$PP$ given that the game passes through~$y m$; hence~$EE_R [Z | e "crossed"] = s(e)$. The first identity follows from the
  law of total expectation.
]

For the repertoire of~@fig:tree, @eq:value is a sum over the unanswered
moves after 1.e4 e5, after 2.Nf3 d5, after 2.f4 Bc5, and after each of the
three last prepared moves. @tab:example gives the numerical values.

#remark(title: [Lines ending with a prepared move])[
  Let~$x in D$ and~$y = x R(x)$ be such that no opponent move at~$y$ is
  answered: the line _ends_ with the prepared move~$R(x)$. Then, by the law
  of total expectation,
  $
    sum_m q(y, m) s(y, m) = s(x, R(x)).
  $ <eq:consistency>
  In~@eq:value, the terms of all the moves~$m$ at such a node~$y$ can
  therefore be replaced by the single term~$pi_R (x) s(x, R(x))$: the value
  of a line that ends with a prepared move is the score of that move.
  This is the form used by Lirep, and we use it in~@tab:example. The two
  forms are equal in the model; they differ when~$s$ and~$q$ are replaced by
  estimates, since~@eq:consistency need not hold for the estimates
  (@sec:data). The form with~$s(x, R(x))$ uses the sample of the games in
  which the prepared move itself was played, which is the more natural one.
] <rem:line-end>

#remark(title: [Backward induction])[
  @eq:value can be evaluated by recursion from the leaves of the
  repertoire. For~$y in Y(R)$, define~$v_R (y)$ as the conditional
  expectation of~$Z$ under~$PP_R$ given that the game passes through~$y$.
  Then
  $
    v_R (y) = sum_m q(y, m) dot cases(
      v_R (y m R(y m)) quad & "if" y m in D",",
      s(y, m) & "otherwise",
    )
  $
  and~$V(R) = v_R (x_0)$ if~$x_0 in Nopp$, and~$V(R) = v_R (x_0 R(x_0))$
  otherwise. Evaluating~$V(R)$ requires the frequencies and scores of the
  opponent moves at each node of~$Y(R)$, that is, one query to the database
  per prepared move.
]

= Estimation from a database of games <sec:data>

The quantities~$q$ and~$s$ are not known; they are estimated from a
database. The program uses the opening explorer of Lichess, which returns,
for a position and a population of games (a range of ratings and time
controls), the list of the moves played in it, with, for each move~$a$,
the numbers~$n_W$,~$n_D$ and~$n_B$ of games won by White, drawn, and won by
Black. We write~$n(x, a) = n_W + n_D + n_B$ and~$p(x, a)$ for the number of
points obtained by the player in these games ($n_W + n_D\/2$ for White).

#definition(title: [Estimators])[
  Let~$kappa >= 0$. The estimated frequency and score of the move~$a$ at~$x$
  are
  $
    hat(q)(x, a) = n(x, a) / (sum_b n(x, b)),
    quad quad
    hat(s)(x, a) = (p(x, a) + kappa\/2) / (n(x, a) + kappa),
  $
  where the sum runs over the moves listed by the database at~$x$.
]

The program uses~$kappa = 20$. The parameter~$kappa$ pulls the estimated
score toward~$1\/2$, as if~$kappa$ additional drawn games had been observed;
its effect is negligible when~$n(x, a)$ is large and substantial when it is
of the order of~$kappa$. It has a standard Bayesian interpretation.

#lemma[
  Let the results of the~$n$ games in which a move was played be
  independent with law~$(theta_W, theta_D, theta_L)$ on~${1, 1\/2, 0}$, and put on~$theta$ a Dirichlet prior with parameters~$(alpha, beta, alpha)$, with~$2 alpha + beta = kappa$. Then the posterior
  mean of the expected score~$theta_W + theta_D\/2$ is~$(p + kappa\/2) \/ (n + kappa)$, where~$p$ is the number of points scored.
]

#proof[
  The Dirichlet prior is conjugate to the multinomial likelihood: the
  posterior is Dirichlet with parameters~$(alpha + n_1, beta + n_(1\/2), alpha + n_0)$, where~$n_r$ is the number
  of games with result~$r$, and its mean is the vector of these parameters
  divided by~$n + kappa$. Hence the posterior mean of~$theta_W + theta_D\/2$ is~$(n_1 + alpha + (n_(1\/2) + beta)\/2)\/(n + kappa) = (p + kappa\/2)\/(n + kappa)$,
  since~$alpha + beta\/2 = kappa\/2$.
]

Three sources of error should be kept in mind.

_Sampling error._ Since~$Z in [0, 1]$, its variance is at most~$1\/4$, and
the standard deviation of the empirical score of a move played in~$n$
independent games is at most~$1\/(2 sqrt(n))$: about~$0.05$ for~$n = 100$
and~$0.016$ for~$n = 1000$.

_Selection bias._ The algorithm chooses, among several candidate moves, the
one with the largest estimated score. If~$hat(s)_1, dots, hat(s)_k$ are
unbiased estimators of~$s_1, dots, s_k$, then~$EE[max_i hat(s)_i] >= max_i s_i$, with a gap that grows with the variance
of the estimators and with~$k$: the maximum of noisy estimates is
optimistic. This is why the program only considers, at each player node,
the~$k = 6$ most played moves among those played in at least~$n_"min" = 100$ games, and uses~$kappa > 0$.

_Positions versus histories._ The database is indexed by positions, so the
data at a node~$x$ aggregates all the games reaching the position of~$x$,
by any move order. The model of~@sec:model is then applied with~$q(x, dot)$
and~$s(x, dot)$ depending on~$x$ through its position only, which is a
modelling assumption. Moreover, the database lists a limited number of
moves at each position (about a dozen); the frequencies are normalized over
the listed moves, and the omitted moves, which are rare, are ignored. For
these reasons~@eq:consistency holds only approximately for the estimates.

In the next two sections, the results are stated for the model of
@sec:model, with the exact quantities~$q$ and~$s$. The program applies the
same formulas with the estimates~$hat(q)$ and~$hat(s)$ in their place, with
the form of~@rem:line-end for the lines ending with a prepared move; the
identities that rely on~@eq:consistency then hold only approximately.

= The optimization problem <sec:problem>

The player has a budget of~$B$ moves to memorize. Two constraints restrict
the repertoires considered, both motivated by the estimation errors of
@sec:data. For each player node~$x$, a finite set~$A(x)$ of _candidate
moves_ is given (in the program, the most played moves with at least~$n_"min"$ games), and a threshold~$rho in [0, 1]$ is given (in the program,~$rho = 0.002$).

#definition(title: [Admissible repertoires and the problem])[
  A repertoire~$R$ is _admissible_ if~$R(x) in A(x)$ and~$pi_R (x) >= rho$
  for every~$x in D$: only candidate moves are prepared, and only at nodes
  reached in a proportion at least~$rho$ of the games. Given an admissible
  repertoire~$R_0$ (possibly empty) and a budget~$B in NN$, the problem is
  $
    "maximize" V(R) quad "over admissible repertoires" R "extending" R_0
    "with" |R| <= |R_0| + B.
  $ <eq:problem>
  Here~$R$ _extends_ $R_0$ if~$D_0 subset D$ and~$R = R_0$ on~$D_0$.
]

Starting from a non-empty~$R_0$ corresponds to completing an existing
repertoire, which is the common situation in practice. Since~$T$ and the
sets~$A(x)$ are finite, @eq:problem has a solution. The next result shows
that it has a separable structure.

For a node~$z in Nown$ and a repertoire~$S$ whose domain is contained in~$T_z$ and which is a repertoire for the game started at~$z$ (in the sense of
@def:repertoire with~$x_0$ replaced by~$z$), we denote by
$
  V_z (S) = EE[Z | "the game passes through" z, "the player follows" S]
$
its value in the game started at~$z$, with the convention~$V_z (emptyset) = s(e)$
when~$z$ is the child of the edge~$e$.

#theorem(title: [Decomposition])[
  Let~$R$ be a repertoire with~$D != emptyset$ or~$x_0 in Nopp$, and~$R'$ a
  repertoire extending~$R$, with domain~$D'$. For each~$e = (y, m) in U(R)$, let~$z_e = y m$ and let~$S_e$ be the restriction of~$R'$ to the nodes of~$T_(z_e)$. Then
  $
    V(R') - V(R) = sum_(e in U(R)) pi_R (e) (V_(z_e)(S_e) - s(e)),
    quad quad
    |R'| - |R| = sum_(e in U(R)) |S_e|.
  $ <eq:decomposition>
] <thm:decomposition>

#proof[
  We first check that every node~$x in D' without D$ lies in exactly one of
  the subtrees~$T_(z_e)$. They are disjoint: if~$z_e$ were a proper prefix
  of~$z_(e')$, the parent~$y'$ of~$z_(e')$, which belongs to~$Y(R)$, would
  be a descendant of~$z_e$, hence of the form~$x' R(x')$ with~$x' in D inter T_(z_e)$; since the player nodes on the path from~$x_0$
  to~$x'$ belong to~$D$, so would~$z_e$, a contradiction. Now let~$x in D' without D$, and let~$u$ be the last node of the path from~$x_0$
  to~$x$ that belongs to~$D union Y(R)$ (the root belongs to this set by
  the assumption on~$R$). If~$u in D$, the next node of the path is~$u R'(u) = u R(u) in Y(R)$, a contradiction; so~$u in Y(R)$, the next node~$u m$ is not in~$D$, and~$(u, m) in U(R)$ with~$x in T_(u m)$. This proves
  the identity on the sizes.

  The transitions~$k_R$ and~$k_(R')$ coincide outside of~$D' without D$, and~$D' without D$ is contained in the union of the~$T_(z_e)$. Hence the two
  walks coincide until the edge of~$U(R)$ that the game crosses, and~$PP_(R')("the game crosses" e) = pi_R (e)$. Given that~$e$ is crossed,
  the continuation under~$PP_(R')$ follows~$S_e$ at the nodes of its domain
  and the population frequencies elsewhere, so the conditional expectation
  of~$Z$ is~$V_(z_e)(S_e)$. By the law of total expectation,~$V(R') = sum_(e in U(R)) pi_R (e) V_(z_e)(S_e)$, and subtracting
  @eq:value gives the result.
]

#figure(
  {
    set text(size: 8.5pt)
    cetz.canvas(length: 1cm, {
      import cetz.draw: *
      let r = 0.15
      // The repertoire R, shaded.
      line((0, 0), (-3.6, -3.2), (3.6, -3.2), close: true, fill: rgb("#f3e3e0"), stroke: none)
      content((0, -1.9), [$R$], anchor: "center")
      // Three unanswered moves leaving R, with the subtrees below them.
      let tails = ((-2.6, -3.2), (0.2, -3.2), (2.9, -3.2))
      let heads = ((-3.6, -4.6), (0.2, -4.6), (3.9, -4.6))
      let names = ($e_1$, $e_2$, $e_3$)
      let budgets = ($S_(e_1)$, $S_(e_2)$, $S_(e_3) = emptyset$)
      for i in range(3) {
        let (t, h) = (tails.at(i), heads.at(i))
        let (hx, hy) = h
        line((hx, hy), (hx - 1.1, hy - 2.2), (hx + 1.1, hy - 2.2), close: true,
          stroke: (paint: luma(140), thickness: 0.5pt, dash: "dotted"))
        if i < 2 {
          line((hx, hy), (hx - 0.6, hy - 1.4), (hx + 0.5, hy - 1.4), close: true,
            fill: rgb("#e7c4bd"), stroke: none)
        }
        line(t, h, stroke: (paint: luma(80), thickness: 0.7pt, dash: "dashed"))
        content(((t.at(0) + hx) / 2, (t.at(1) + hy) / 2), names.at(i), anchor: "west", padding: 4pt)
        circle(t, radius: r, fill: white, stroke: 0.7pt)
        rect((hx - r, hy - r), (hx + r, hy + r), fill: luma(30), stroke: 0.7pt)
        content((hx, hy - 2.45), budgets.at(i), anchor: "north")
        content((hx + 0.55, hy), $z_(e_#(i + 1))$, anchor: "west")
      }
      circle((0, 0), radius: r, fill: white, stroke: 0.7pt)
      content((0, 0.25), $x_0$, anchor: "south")
    })
  },
  caption: [
    @thm:decomposition. An extension~$R'$ of~$R$ adds, below each
    unanswered move~$e in U(R)$, a repertoire~$S_e$ of the subgame starting at
    the child~$z_e$ of~$e$ (dotted triangle: the subtree~$T_(z_e)$). The
    gain is the sum of the gains~$pi_R (e) (V_(z_e)(S_e) - s(e))$, and the
    number of added moves is the sum of the~$|S_e|$.
  ],
) <fig:decomposition>

@thm:decomposition, illustrated in~@fig:decomposition, reduces~@eq:problem
to a separable resource allocation problem. For~$e in U(R_0)$ and~$c in NN$, let
$
  F_e (c) = max {V_(z_e)(S) - s(e) : S "admissible below" z_e, thick |S| <= c},
$ <eq:Fe>
where "admissible below~$z_e$" means that~$R_0$ extended by~$S$ is
admissible. Then the optimal value of~@eq:problem is
$
  V(R_0) + max {sum_(e in U(R_0)) pi_(R_0)(e) F_e (c_e) : c_e in NN, thick sum_e c_e <= B}.
$ <eq:allocation>
Both~@eq:Fe and~@eq:allocation can be solved exactly by dynamic programming
on the tree, in the manner of a knapsack problem (see
@sec:lookahead for the recursion). The difficulty is not the computation
but the data: evaluating~$F_e (c)$ requires the frequencies and scores at
every node that a repertoire of size~$c$ below~$z_e$ can reach. With~$k$
candidate moves per player node and~$b$ opponent moves per opponent node
that pass the threshold~$rho$, there are of the order of~$(k b)^c$ such
nodes. Each node costs one query to the database, and the public explorer
of Lichess answers about one query per second. For~$B = 50$, the exact
solution is out of reach, and an algorithm that queries few nodes is
needed.

= The greedy algorithm <sec:greedy>

== Description

The greedy algorithm adds one move at a time, each time the one whose
addition increases~$V$ the most. By~@thm:decomposition, the effect of a
single move is explicit.

#lemma(title: [Gain of one move])[
  Let~$R$ be a repertoire,~$e = (y, m) in U(R)$,~$z = y m$, and~$a in A(z)$.
  Let~$R + (e, a)$ be the repertoire extending~$R$ by~$R(z) = a$. Then
  $
    V(R + (e, a)) - V(R) = pi_R (e) (s(z, a) - s(e)).
  $ <eq:gain>
  Moreover, the identity~$sum_a q(z, a) s(z, a) = s(e)$ holds: the gain is the probability of
  the move~$e$ times the excess of the score of~$a$ over the average score of
  the population at~$z$. In particular, if the move of largest score at~$z$
  is a candidate, the largest gain at~$e$ is nonnegative.
] <lem:gain>

#proof[
  Apply~@thm:decomposition with~$S_e = {z |-> a}$ and~$S_(e') = emptyset$ for~$e' != e$. After the move~$a$, no move is prepared, so~$V_z (S_e) = EE[Z | "the game passes through" z a] = s(z, a)$. The
  identity~$sum_a q(z, a) s(z, a) = s(e)$ is the law of total expectation;
  since a maximum is not smaller than an average, the last claim follows.
]

The data needed to compute~$pi_R (e)$ and~$s(e)$ are those at the node~$y$,
which belongs to~$Y(R)$ and has been queried already when evaluating~$V(R)$; only the score~$s(z, a)$ requires a query at the new node~$z$. The bound~$s(z, a) <= 1$ gives the following upper bound, which does not require this
query.

#lemma(title: [Bound])[
  For every~$e in U(R)$ and~$a in A(z_e)$,~$V(R + (e, a)) - V(R) <= beta(e) := pi_R (e) (1 - s(e))$.
] <lem:bound>

The algorithm sorts the unanswered moves by decreasing bound and examines
them in this order, querying the database at~$z_e$; it stops as soon as the
bound of the next move does not exceed the best gain found so far. Since the
bound is an upper bound, the move found is a maximizer of the gain over all
pairs~$(e, a)$, although only a few nodes are queried. This is a
branch-and-bound search of depth one.

#figure(
  kind: "algorithm",
  supplement: [Algorithm],
  block(width: 100%, inset: (x: 0.8em, y: 0.7em), stroke: (top: 0.6pt, bottom: 0.6pt), align(left)[
    #set text(size: 9.5pt)
    #set par(justify: false)
    *Input:* an admissible repertoire~$R_0$, a budget~$B$, candidate sets~$A(dot)$, a threshold~$rho$. \
    *Output:* an admissible repertoire~$R$ extending~$R_0$ with~$|R| <= |R_0| + B$.
    #set enum(numbering: "1.", indent: 0.4em)
    + $R <- R_0$.
    + *while* $|R| < |R_0| + B$ *do*
      + Compute~$pi_R (e)$ and~$s(e)$ for every~$e in U(R)$ such that~$pi_R (e) >= rho$, and sort these moves by decreasing~$beta(e) = pi_R (e)(1 - s(e))$.
      + $g^* <- -infinity$.
      + *for* $e$ in this order *do*
        + *if* $beta(e) <= g^*$ *then* *break*.
        + Query the database at~$z_e$. For each~$a in A(z_e)$, compute~$g = pi_R (e)(s(z_e, a) - s(e))$; if~$g > g^*$, set~$g^* <- g$ and~$(e^*, a^*) <- (e, a)$.
      + *if* $g^* <= 0$ *then* *return* $R$.
      + $R <- R + (e^*, a^*)$.
    + *return* $R$.
  ]),
  caption: [The greedy algorithm with pruning.],
) <alg:greedy>

When the root is a player node and~$D_0 = emptyset$, the first move is chosen among the candidates at
the root by its score, since then~$V({x_0 |-> a}) = s(x_0, a)$. The program
also accepts a target value instead of a budget, in which case the loop
stops when~$V(R)$ reaches the target; since moves are added one at a time,
the value after each addition is available, and the output is a whole
sequence of nested repertoires, one per budget.

== The greedy algorithm is not optimal

The greedy algorithm only sees one move ahead. A move whose own gain is
small, but which makes a large gain possible at the next move, is missed.

#example[
  Consider the tree of~@fig:counter. The root~$x_0$ is an opponent node with
  two moves~$m_1, m_2$, each of frequency~$1\/2$ and of score~$1\/2$. At~$z_1 = x_0 m_1$ the only candidate is~$a$, with~$s(z_1, a) = 1\/2$; after
  it, the opponent plays~$r_1$ or~$r_2$, each with frequency~$1\/2$, with
  scores~$0.3$ and~$0.7$. At~$z_1 a r_1$ the only candidate is~$b$, with
  score~$1$. At~$z_2 = x_0 m_2$, the only candidate is~$c$, with~$s(z_2, c) = 1\/2 + epsilon$,~$0 < epsilon < 0.35$. There are no other
  candidates, and~$rho = 0$. These numbers satisfy~@eq:consistency (at~$z_1 a$,~$(0.3 + 0.7)\/2 = 1\/2$).

  With~$B = 2$, the greedy algorithm compares the gains~$1\/2 dot (1\/2 - 1\/2) = 0$ for~$a$ and~$epsilon\/2$ for~$c$, and
  chooses~$c$. At the second step, the only addition is~$a$, with gain~$0$,
  and the algorithm stops: its gain is~$epsilon\/2$. The repertoire~${z_1 |-> a, z_1 a r_1 |-> b}$ has gain~$1\/2 dot 1\/2 dot (1 - 0.3) = 0.175$. As~$epsilon -> 0$, the ratio of the
  greedy gain to the optimal gain tends to zero.
] <ex:counter>

#figure(
  {
    set text(size: 8.5pt)
    cetz.canvas(length: 1cm, {
      import cetz.draw: *
      let r = 0.15
      let opp(p) = circle(p, radius: r, fill: white, stroke: 0.7pt)
      let own(p) = rect((p.at(0) - r, p.at(1) - r), (p.at(0) + r, p.at(1) + r), fill: luma(30), stroke: 0.7pt)
      let mid(a, b) = ((a.at(0) + b.at(0)) / 2, (a.at(1) + b.at(1)) / 2)
      // Opponent moves: right, vertically, then right, as in Figure 1.
      let reply(a, b, body) = {
        line(a, (a.at(0) + 0.35, a.at(1)), (a.at(0) + 0.35, b.at(1)), b, stroke: 0.6pt)
        content(((a.at(0) + 0.35 + b.at(0)) / 2, b.at(1)), body, anchor: "south", padding: 2.5pt)
      }
      let prepared(a, b, body, colour: accent) = {
        line(a, b, stroke: (paint: colour, thickness: 1.4pt))
        content(mid(a, b), text(fill: colour, body), anchor: "south", padding: 3pt)
      }
      let x0 = (0, 0)
      let z1 = (2.8, 1.3)
      let z2 = (2.8, -1.3)
      let y1 = (5.0, 1.3)
      let y2 = (5.0, -1.3)
      let w1 = (7.8, 2.2)
      let w2 = (7.8, 0.4)
      let u1 = (10.0, 2.2)
      reply(x0, z1, [$m_1$: $1\/2$, $s = 0.5$])
      reply(x0, z2, [$m_2$: $1\/2$, $s = 0.5$])
      prepared(z1, y1, [$a$: $s = 0.5$])
      prepared(z2, y2, [$c$: $s = 0.5 + epsilon$], colour: luma(110))
      reply(y1, w1, [$r_1$: $1\/2$, $s = 0.3$])
      reply(y1, w2, [$r_2$: $1\/2$, $s = 0.7$])
      prepared(w1, u1, [$b$: $s = 1$])
      for p in (x0, y1, y2, u1) { opp(p) }
      for p in (z1, z2, w1, w2) { own(p) }
      content((x0.at(0) - 0.3, x0.at(1)), $x_0$, anchor: "east")
      content((z1.at(0), z1.at(1) - 0.3), $z_1$, anchor: "north")
      content((z2.at(0), z2.at(1) - 0.3), $z_2$, anchor: "north")
    })
  },
  caption: [
    @ex:counter. Edge labels give the frequency of opponent moves and the
    score of every move. With two moves to memorize, the optimal repertoire
    is~$\{a, b\}$ (red), of gain~$0.175$; the greedy algorithm first chooses~$c$ (grey), of gain~$epsilon\/2$, and then cannot use~$b$.
  ],
) <fig:counter>

In the language of~@eq:allocation, the greedy algorithm fails because the
functions~$F_e$ need not be concave: in~@ex:counter, the function~$F_e$
with~$e = (x_0, m_1)$ satisfies~$F_e (0) = F_e (1) = 0$ and~$F_e (2) = 0.35$. For separable problems
with concave nondecreasing functions, the greedy allocation of one unit at a
time is optimal (a classical result on resource allocation going back to
Gross, see~@fox and the monograph~@ibaraki); here the
functions~$F_e$ are only known to be nondecreasing, and the set~$U(R)$
changes as moves are added.

== Look-ahead <sec:lookahead>

The program offers a variant with a parameter~$K >= 1$: for each unanswered
move~$e$ examined, it computes the best repertoires below~$z_e$ with at most~$c$ moves, that is,~$F_e (c)$ in~@eq:Fe, for~$c = 1, dots, K$, and among all
pairs~$(e, c)$ it adds the repertoire with the largest _gain per move_
$pi_R (e) F_e (c) \/ c$, all of its moves at once. For~$K = 1$ this is
@alg:greedy. In
@ex:counter,~$K = 2$ finds the gain per move~$0.175\/2 > epsilon\/2$ and
returns the optimal repertoire.

The values~$F_e (c)$,~$c <= K$, are computed by the following recursion, from the
leaves up. For a player node~$z$ reached by the opponent move~$e$, and an
opponent node~$y$, define, for~$c = 0, dots, K$,
- $G_z (c)$: the largest value of a repertoire of size at most~$c$ below~$z$, conditionally on reaching~$z$; thus~$G_z (0) = s(e)$;
- $H_y (c)$: the same quantity at the opponent node~$y$, for repertoires of
  size at most~$c$ prepared after the moves at~$y$.
Then~$H_y (0) = sum_m q(y, m) s(y, m)$, and, for~$c >= 1$,
$
  G_z (c) = max (G_z (0), thick max_(a in A(z)) H_(z a)(c - 1)),
  quad quad
  H_y (c) = max_(c_m >= 0, thick sum_m c_m <= c) thick sum_m q(y, m) G_(y m)(c_m),
$
where the inner maximum is a knapsack over the opponent moves at~$y$, solved
by adding the moves one at a time in~$O(K^2)$ operations each, and where
we set~$G_(y m)(c) = G_(y m)(0)$ for all~$c$ if the probability of reaching~$y m$
is below~$rho$. Then~$F_e (c) = G_(z_e)(c) - s(e)$ for~$c <= K$. In the model,
the identity~$H_(z a)(0) = s(z, a)$ holds by~@eq:consistency; since the estimates satisfy it
only approximately, the program uses~$s(z, a)$, the score of the move~$a$
itself, as the value of a line ending with~$a$, in accordance with
@rem:line-end. The bound of~@lem:bound still applies, since~$pi_R (e) F_e (c) \/ c <= pi_R (e) F_e (c) <= beta(e)$, and the
pruning rule is unchanged.

The cost of the look-ahead is that of the data: examining~$e$ requires the
nodes reachable by~$K$ prepared moves below~$z_e$, of the order of~$(k b)^K$ queries. The choice by gain per move is a heuristic, as for the
knapsack problem, and the look-ahead variant is not optimal either: an
example of the same type as~@ex:counter, with a chain of~$K + 1$ moves,
defeats it.

= A numerical illustration <sec:numerics>

We consider Black after 1.e4 e5, with~$R_0 = emptyset$, and the population
of blitz and rapid games on Lichess in which the average rating of the two
players is at least 2000 (about~$8 times 10^7$ games through 1.e4 e5). The
parameters are those described above:~$kappa = 20$, at most~$k = 6$
candidate moves per node, each played in at least~$n_"min" = 100$ games, and~$rho = 0.002$. The value of the empty repertoire is the score of Black in
the population after 1.e4 e5,~$V(emptyset) = 47.63%$.

#figure(
  {
    set text(size: 9pt)
    table(
      columns: (auto, auto, auto, auto),
      align: (left, right, right, right),
      stroke: none,
      inset: (x: 7pt, y: 3.5pt),
      table.hline(stroke: 0.6pt),
      table.header([Where the game leaves~$R$], [$pi_R$], [mean score], [contribution]),
      table.hline(stroke: 0.4pt),
      [2.Nc3, 2.d4, 2.Bc4, ... (10 moves)], [0.2113], [0.4691], [0.0991],
      [2.Nf3 d5 3.d4, 3.Nc3, ... (10 moves)], [0.1423], [0.5102], [0.0726],
      [2.f4 Bc5, moves other than 3.Nf3 (11 moves)], [0.0050], [0.5313], [0.0026],
      [line ends: 2.Nf3 d5 3.exd5 Nf6], [0.3240], [0.5300], [0.1717],
      [line ends: 2.Nf3 d5 3.Nxe5 Qe7], [0.2339], [0.5353], [0.1252],
      [line ends: 2.f4 Bc5 3.Nf3 d5], [0.0835], [0.5571], [0.0465],
      table.hline(stroke: 0.4pt),
      [Total], [1.0000], [], [0.5178],
      table.hline(stroke: 0.6pt),
    )
  },
  caption: [
    The terms of~@eq:value for the repertoire of~@fig:tree, grouped, in the
    form of~@rem:line-end: a group of unanswered moves contributes the sum
    of~$pi_R (e) s(e)$ over its moves, and a line ending with a prepared
    move~$R(x)$ contributes~$pi_R (x) s(x, R(x))$. The middle column is the
    contribution divided by the probability. The value is~$V(R) = 51.78%$.
  ],
  kind: table,
) <tab:example>

The first five moves chosen by~@alg:greedy are those of~@fig:tree, in the
order 2.Nf3 d5, 3.Nxe5 Qe7, 3.exd5 Nf6, 2.f4 Bc5, 3.Nf3 d5. The first one
illustrates~@lem:gain: the move 2.Nf3 is played in 70.0% of the games,
Black's average score after it is~$s(e) = 47.6%$, and 2...d5 scores~$s(z, a) = 51.4%$, so that the gain is~$0.700 times (0.514 - 0.476) approx 2.65$ points. @tab:example shows how
the value~$51.78%$ of the resulting repertoire splits over the ways of
leaving it.

#figure(
  {
    let rows = csv("greedy-run.csv").slice(1)
    let data = rows.map(r => (int(r.at(0)), float(r.at(1))))
    set text(size: 8.5pt)
    cetz.canvas({
      plot.plot(
        size: (11, 5.5),
        x-label: [number of memorized moves~$|R|$],
        y-label: [$V(R)$ (%)],
        x-tick-step: 10,
        y-tick-step: 2,
        y-min: 47,
        y-max: 56,
        x-min: 0,
        x-max: 50,
        x-grid: true,
        y-grid: true,
        {
          plot.add(data, mark: "o", mark-size: 0.08, style: (stroke: (paint: accent, thickness: 0.9pt)),
            mark-style: (fill: accent, stroke: none))
        },
      )
    })
  },
  caption: [
    Value of the repertoires produced by~@alg:greedy for Black after 1.e4 e5,
    as a function of the number of moves (one run of 50 steps). The gains
    decrease overall but not monotonically: the 13th move (3...d6 after
    2.d4 Nc6 3.dxe5) gains 0.37 points, while the 12th (2...Nc6 against
    2.d4), which made it possible, gained 0.08.
  ],
) <fig:run>

@fig:run shows the value along the run: after 50 moves,~$V(R) = 55.44%$,
an increase of 7.8 points. The run queried the database at 193 nodes, a
small fraction of the nodes that an exact solution of~@eq:problem would
require. The sequence of gains decreases overall, which reflects the fact
that the first moves answer the most frequent opponent moves. It is not
monotone, however, and the exceptions have the structure of~@ex:counter: a
move of small gain opens a branch where a larger gain becomes available. In
this run, the greedy algorithm took these moves for their own small gain,
but nothing guarantees that it does so in general.

The first move of the run, the gambit 2...d5 against 2.Nf3, is generally
considered objectively dubious. Its good score in the population is a
reminder of what~$s(z, a)$ measures, which is the subject of the next
section.

= Discussion of the hypotheses <sec:discussion>

@hyp:opp is natural if the population is chosen to match the player's
actual opponents (rating range and time control). It does exclude
opponents who adapt to the player's repertoire, for instance by preparing
against it.

@hyp:out is the strongest assumption. The score~$s(z, a)$ is the mean
result of the players of the population who _chose_ to play~$a$ at~$z$. If
those who choose a rare move are, more often than others, players who know
it well, then~$s(z, a)$ overestimates the score of a player who adopts the
move because an algorithm recommended it. In statistical language,~$s(z, a)$
is an observational quantity, and the choice of~$a$ is not randomized. The
assumption is more plausible for the opponent moves, whose frequencies are
what the player will actually face, than for the scores of the player's own
rare moves; the threshold~$n_"min"$ and the shrinkage parameter~$kappa$
limit, but do not remove, this effect.

The objective itself can be changed without changing the algorithm. If the
score~$s$ is replaced, at the edges where the game leaves the repertoire, by
another function~$g$, for instance a chess engine's evaluation of the
position converted to an expected score by a logistic function, then
@eq:value with~$g$ in place of~$s$ defines an objective, and
@thm:decomposition, @lem:gain (without the claim on the sign of the gain)
and the algorithms carry over. What is lost is the probabilistic
interpretation as an expected score, and~@eq:consistency, so that the value
assigned to a line ending with a prepared move becomes a modelling choice.
The program offers such objectives; we have restricted the exposition to
the expected score, for which the model is the cleanest.

Finally, two simplifications deserve mention. The model assumes that the
player always remembers the prepared move; a probability of forgetting could
be included by mixing~$k_R (x, dot)$ with~$q(x, dot)$ at the nodes of~$D$,
which would make the gain of a move proportional to the probability of
remembering it. And the budget counts memorized moves uniformly, whereas
moves on frequent lines are rehearsed more often and are easier to retain.

#bibliography("refs.bib", title: "References", style: "ieee")
