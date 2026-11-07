/** The idea in one line, between the replay and the evidence. */
export function Thesis() {
  return (
    <section className="ch thesis" aria-label="The idea">
      <div className="ch-inner">
        <p className="thesis-line">
          <span>Don't authorize the command.</span>
          <span className="thesis-two">Authorize its measured effect.</span>
        </p>
        <p className="thesis-why">
          Allowlists, linters and rules in a prompt judge what a command says. Shadow Run runs it on a full copy of prod first and judges what it did. That matters more than it sounds: told which rule it broke, an agent can learn to get around the rule, and only a measurement catches it.
        </p>
      </div>
    </section>
  );
}
